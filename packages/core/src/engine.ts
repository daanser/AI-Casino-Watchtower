/**
 * 回合编排器 —— 把钱包、游戏模块、事件总线串成一条完整链路
 *
 * 一局的完整生命周期：
 *   start()  → 建局 + 扣注（同一事务）→ 写事件 → 广播
 *   act()    → 校验动作 → 推进状态 → 写事件 → 广播；如果游戏结束就结算并派彩
 *   settle() → 派彩入账 + 揭示种子 + 标记 settled
 *
 * 广播时机很关键：所有帧先在事务里攒进 sink，等 COMMIT 成功之后才 publish。
 * 否则一旦事务回滚，前端会看到一场根本没发生过的牌局。
 */

import {
  PlaygroundError,
  type Cents,
  type GameId,
  type RoundEventRow,
  type RoundRow,
  type RoundStatus,
  type ServerFrame,
} from '@ai-gaming/shared';
import { all, one, run, tx, type Db } from '@ai-gaming/db';
import { EventBus } from './events';
import { commitOf, newClientSeed, newServerSeed, verifyCommit } from './fairness';
import { makeRng } from './rng';
import { WalletService } from './wallet';
import { createRegistry } from './games';
import type {
  GameAction,
  GameEventDraft,
  GameModule,
  SettleResult,
  TimelineStep,
} from './games/types';

// ─────────────────────────────────────────────────────────────
// 单写者锁
// ─────────────────────────────────────────────────────────────

/**
 * 把「一整个回合生命周期」串行化。
 *
 * 因为 node:sqlite 是同步 API、Node 又是单线程，目前的临界区里其实一个 await
 * 都没有，这把锁是零争用的——它的价值在于：万一以后某个游戏逻辑里出现了异步调用
 * （比如要等一个外部服务），串行化保证不会悄悄失效。多个 AI 并行玩时，
 * 这道锁就是「同一钱包不会算错账」的那道防线。
 */
export class WriteLock {
  private tail: Promise<unknown> = Promise.resolve();

  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

export interface GameConfigRow {
  game_id: string;
  enabled: number;
  min_bet_cents: number;
  max_bet_cents: number;
  house_edge_bp: number;
  params_json: string;
}

export interface StartRoundInput {
  walletId: number;
  gameId: string;
  betCents: Cents;
  params?: Record<string, unknown>;
  clientSeed?: string;
  tableId?: string;
  actor?: string;
  /** 开局前的选择理由（Bot 切游戏时会显示「为什么来这个游戏」） */
  reasoning?: string;
}

export interface ActOptions {
  actor?: string;
  /** 「我为什么这么打」——AI 的自述理由，会存成事件并实时广播给前端 */
  reasoning?: string;
}

/** 对外可见的对局快照。注意：这里永远不含隐藏局面，也不含未结算的种子。 */
export interface PublicRound {
  id: number;
  gameId: string;
  tableId: string;
  walletId: number;
  betCents: Cents;
  status: RoundStatus;
  payoutCents: Cents;
  netCents: Cents;
  seedCommit: string;
  /** 只有结算之后才给 */
  serverSeed: string | null;
  clientSeed: string;
  nonce: number;
  startedAt: string;
  settledAt: string | null;
  /** 已过滤的局面：不含暗牌 / 崩溃点 / 中奖号码 */
  view: Record<string, unknown>;
}

export interface ActResult {
  round: PublicRound;
  balanceAfter: Cents;
  settled: boolean;
}

export interface TableSummary {
  tableId: string;
  gameId: string;
  players: number;
  lastActivity: string | null;
  openRounds: number;
}

// ─────────────────────────────────────────────────────────────
// 服务
// ─────────────────────────────────────────────────────────────

export class RoundService {
  private readonly games = createRegistry();
  private readonly lock = new WriteLock();

  constructor(
    private readonly db: Db,
    private readonly wallets: WalletService,
    private readonly bus: EventBus,
  ) {}

  get registry() {
    return this.games;
  }

  /** Bot 切换游戏时广播醒目的提示；具体理由还会随下一局的 reasoning 一并落库。 */
  announceGameSwitch(input: {
    botId: string;
    displayName: string;
    tableId: string;
    fromGameId: string;
    toGameId: string;
    reason: string;
  }): void {
    this.bus.publish({
      type: 'game_switch',
      botId: input.botId,
      displayName: input.displayName,
      tableId: input.tableId,
      fromGameId: input.fromGameId as GameId,
      toGameId: input.toGameId as GameId,
      reason: input.reason,
      atMs: Date.now(),
    });
  }

  // ── 配置 ─────────────────────────────────────────────────────

  config(gameId: string): GameConfigRow {
    const row = one<GameConfigRow>(
      this.db,
      'SELECT * FROM game_configs WHERE game_id = ?',
      gameId,
    );
    if (row) return row;
    const game = this.games.require(gameId);
    return {
      game_id: gameId,
      enabled: 1,
      min_bet_cents: game.meta.minBetCents,
      max_bet_cents: game.meta.maxBetCents,
      house_edge_bp: 0,
      params_json: '{}',
    };
  }

  // ── 开局 ─────────────────────────────────────────────────────

  async start(input: StartRoundInput): Promise<PublicRound> {
    return this.lock.run(() => this.startInner(input));
  }

  private startInner(input: StartRoundInput): PublicRound {
    const game = this.games.require(input.gameId);
    const cfg = this.config(input.gameId);

    if (!cfg.enabled) {
      throw new PlaygroundError('GAME_DISABLED', `游戏已关闭: ${input.gameId}`, 409);
    }
    if (
      !Number.isInteger(input.betCents) ||
      input.betCents < cfg.min_bet_cents ||
      input.betCents > cfg.max_bet_cents
    ) {
      throw new PlaygroundError(
        'BET_OUT_OF_RANGE',
        `注额必须是 ${cfg.min_bet_cents} ~ ${cfg.max_bet_cents} 分之间的整数（单位：分）`,
        400,
      );
    }
    this.wallets.getOrThrow(input.walletId);

    const tableId = input.tableId ?? `${input.gameId}-1`;
    const actor = input.actor ?? `wallet:${input.walletId}`;
    const clientSeed = input.clientSeed ?? newClientSeed();
    const serverSeed = newServerSeed();
    const seedCommit = commitOf(serverSeed);

    const sink: ServerFrame[] = [];

    const out = tx(this.db, () => {
      const nonce =
        Number(
          one<{ c: number }>(
            this.db,
            'SELECT COUNT(*) AS c FROM rounds WHERE wallet_id = ?',
            input.walletId,
          )?.c ?? 0,
        ) + 1;

      // server_seed 从第一刻就存在库里（结算前绝不经 API 暴露），
      // 因为游戏中推进每一步都要用它派生随机数。
      const ins = run(
        this.db,
        `INSERT INTO rounds
           (game_id, table_id, wallet_id, bet_cents, seed_commit, server_seed, client_seed, nonce, state, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 'awaiting_action')`,
        input.gameId,
        tableId,
        input.walletId,
        input.betCents,
        seedCommit,
        serverSeed,
        clientSeed,
        nonce,
      );
      const roundId = Number(ins.lastInsertRowid);

      // 扣注与建局在同一个事务里：要么都成，要么都不成
      const debit = this.wallets.applyInner({
        walletId: input.walletId,
        kind: 'bet',
        deltaCents: -input.betCents,
        roundId,
        idemKey: `r${roundId}:bet`,
      });

      const rng = makeRng(serverSeed, clientSeed, nonce, 0);
      const step = game.init({ betCents: input.betCents, rng, params: input.params ?? {} });

      run(this.db, 'UPDATE rounds SET state = ? WHERE id = ?', JSON.stringify(step.state), roundId);
      this.persistEvents(sink, roundId, tableId, input.gameId, actor, step.events);

      const openingReasoning = input.reasoning?.trim();
      if (openingReasoning) {
        this.persistEvents(sink, roundId, tableId, input.gameId, actor, [
          { type: 'reasoning', payload: { text: openingReasoning }, delayMs: 0 },
        ]);
        sink.push({
          type: 'reasoning',
          roundId,
          tableId,
          actor,
          gameId: input.gameId as GameId,
          text: openingReasoning,
          atMs: 0,
        });
      }

      this.chargeExtraStake(sink, roundId, input.walletId, step, 0, debit.balanceAfter);
      let settled: SettleResult | null = null;

      if (step.done) {
        const round = this.getRoundRow(roundId);
        const info = this.settleInner(sink, round, game, step.state, actor);
        settled = {
          payoutCents: info.payoutCents,
          stakedCents: info.stakedCents,
          breakdown: info.breakdown,
        };
      }

      sink.push({
        type: 'round_started',
        roundId,
        tableId,
        gameId: input.gameId as GameId,
        walletId: input.walletId,
        betCents: input.betCents,
        view: game.publicView(step.state),
        seedCommit,
        atMs: 0,
      });
      // 下注扣款单独一条，余额用「扣注后」的值。
      // 以前这里用结算后的余额配净额：开局即结算的局（黑杰克直接 21 点）
      // 看不到注额被扣走的那一下，而中途结算的局则完全没有派彩帧 ——
      // 一直开着页面的观众，余额会永远停在下注后的数字上。
      sink.push({
        type: 'wallet_update',
        walletId: input.walletId,
        balanceCents: debit.balanceAfter,
        deltaCents: -input.betCents,
        reason: 'bet',
        atMs: 0,
      });

      return { roundId, state: step.state, settled: settled !== null };
    });

    // COMMIT 成功之后才广播（按帧上的时刻排程，见 publishTimed）
    this.publishTimed(sink);
    // 实时游戏（大火箭）开局后按时间轴挂定时器：崩溃点一到就炸，不用等玩家动作。
    // 缺了这一步，前端就只能一路瞎飞，最值钱的那一下（眼睁睁看它炸）永远播不出来。
    if (!out.settled) this.armTimeline(out.roundId, game, out.state);
    return this.toPublicRound(this.getRoundRow(out.roundId));
  }

  // ── 动作 ─────────────────────────────────────────────────────

  async act(roundId: number, action: GameAction, opts: ActOptions = {}): Promise<ActResult> {
    return this.lock.run(() => this.actInner(roundId, action, opts));
  }

  private actInner(roundId: number, action: GameAction, opts: ActOptions): ActResult {
    const round = this.getRoundRow(roundId);
    if (round.status !== 'awaiting_action') {
      throw new PlaygroundError(
        'ROUND_NOT_OPEN',
        `这一局已经结束（${round.status}），不能再提交动作`,
        409,
      );
    }

    const game = this.games.require(round.game_id);
    const state = JSON.parse(round.state) as { step?: number };
    game.validate(state, action);

    const actor = opts.actor ?? `wallet:${round.wallet_id}`;
    const sink: ServerFrame[] = [];

    const out = tx(this.db, () => {
      // 「我为什么这么打」先落成一帧事件，回放时也能看到 AI 当时的想法
      const reasoning = opts.reasoning?.trim();
      if (reasoning) {
        this.persistEvents(sink, roundId, round.table_id, round.game_id, actor, [
          { type: 'reasoning', payload: { text: reasoning }, delayMs: 0 },
        ]);
        sink.push({
          type: 'reasoning',
          roundId,
          tableId: round.table_id,
          actor,
          gameId: round.game_id as GameId,
          text: reasoning,
          atMs: 0,
        });
      }

      // 每一步用独立的随机流（step 参与派生），
      // 这样「动作次数」不会扰动后续步骤的随机数，回放时不用重演消耗量。
      const stepIndex = Number(state?.step ?? 0) + 1;
      const rng = makeRng(round.server_seed ?? '', round.client_seed, round.nonce, stepIndex);
      const step = game.act(state, action, rng);

      run(this.db, 'UPDATE rounds SET state = ? WHERE id = ?', JSON.stringify(step.state), roundId);
      this.persistEvents(sink, roundId, round.table_id, round.game_id, actor, step.events);

      let balanceAfter = this.chargeExtraStake(
        sink,
        roundId,
        round.wallet_id,
        step,
        stepIndex,
        this.wallets.getOrThrow(round.wallet_id).balance_cents,
      );
      let settled = false;

      if (step.done) {
        const info = this.settleInner(sink, round, game, step.state, actor);
        balanceAfter = info.balanceAfter;
        settled = true;
      }

      return { balanceAfter, settled };
    });

    this.publishTimed(sink);
    // 玩家先收手、或庄家到点自己动手 —— 这局结束了，把还在等的定时器撤掉
    if (out.settled) this.clearTimeline(roundId);

    return {
      round: this.toPublicRound(this.getRoundRow(roundId)),
      balanceAfter: out.balanceAfter,
      settled: out.settled,
    };
  }

  // ── 广播排程 ─────────────────────────────────────────────────

  /** 排程中的广播定时器，收摊时统一撤掉，否则进程退不出去 */
  private readonly broadcastTimers = new Set<ReturnType<typeof setTimeout>>();

  /**
   * 按帧上的时刻排程广播。
   *
   * 游戏事件本来就带 delayMs（注释里写着「前端按这个在虚拟时钟上播放动画」），
   * 但以前是**一次性全推** —— 老虎机三个转轴同时停、黑杰克四张牌一瞬间全亮、
   * 轮盘的开球瞬间落定。动画根本没有时间可播，delayMs 等于白写。
   *
   * 关键是：事件帧的 atMs 是「相对开局」的**累积**时刻，不能直接当延迟用。
   * 大火箭的爆炸帧 atMs 是 9241，可它本来就是「飞到那一刻才产生」的 ——
   * 再等 9.2 秒就等于把这一局重放一遍。所以要减掉**本批最早事件**的时刻，
   * 换算成批内相对位置。
   *
   * 结算帧（round_settled + 派彩）永远排在最后，否则前端会先看到结果、再看到过程。
   */
  private publishTimed(sink: ServerFrame[]): void {
    const eventAts = sink.flatMap((f) => (f.type === 'round_event' ? [f.atMs ?? 0] : []));
    const batchMin = eventAts.length > 0 ? Math.min(...eventAts) : 0;
    const batchMax = eventAts.length > 0 ? Math.max(...eventAts) : 0;
    const settleDelay = batchMax - batchMin + 150;

    for (const frame of sink) {
      const isSettle =
        frame.type === 'round_settled' ||
        (frame.type === 'wallet_update' && frame.reason === 'payout');
      const delay = isSettle
        ? settleDelay
        : Math.max(0, ((frame as { atMs?: number }).atMs ?? 0) - batchMin);

      if (delay <= 0) {
        this.bus.publish(frame);
        continue;
      }
      const handle = setTimeout(() => {
        this.broadcastTimers.delete(handle);
        this.bus.publish(frame);
      }, delay);
      this.broadcastTimers.add(handle);
    }
  }

  // ── 实时游戏的时间轴 ─────────────────────────────────────────

  /** 进行中回合的定时器，结算时清掉 */
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>[]>();

  /**
   * 按游戏的时间轴挂定时器。
   *
   * `elapsedMs` 用于「重启后接回」：定时器活不过进程重启，所以恢复时要把
   * 已经飞过的时间扣掉，而不是从头再等一遍。
   */
  private armTimeline(
    roundId: number,
    game: GameModule<any>,
    state: unknown,
    elapsedMs = 0,
  ): void {
    const steps = game.timeline?.(state) ?? [];
    if (steps.length === 0) return;

    const handles = steps.map((step) =>
      setTimeout(
        () => {
          void this.fireTimeline(roundId, step);
        },
        Math.max(0, step.atMs - elapsedMs),
      ),
    );
    // 同一局重复挂（理论上不会）时先撤掉旧的，避免两个定时器都开火
    this.clearTimeline(roundId);
    this.timers.set(roundId, handles);
  }

  private async fireTimeline(roundId: number, step: TimelineStep): Promise<void> {
    try {
      const round = this.getRoundRow(roundId);
      // 玩家已经先收手了：这局早就结束，定时器什么也不做
      if (round.status !== 'awaiting_action') return;
      await this.act(roundId, step.action, {
        actor: step.actor ?? '庄家',
        reasoning: step.reasoning,
      });
    } catch (err) {
      // 定时器里的异常绝不能把进程带崩 —— 它发生在事件循环里，
      // 没有调用方可以接住。
      console.error(`[timeline] 第 ${roundId} 局自动推进失败:`, err);
    } finally {
      this.clearTimeline(roundId);
    }
  }

  private clearTimeline(roundId: number): void {
    const handles = this.timers.get(roundId);
    if (!handles) return;
    for (const h of handles) clearTimeout(h);
    this.timers.delete(roundId);
  }

  /**
   * 进程重启后把还在飞的实时回合接回来。
   *
   * 定时器活不过重启，而这类游戏不等玩家动作 —— 不接回来，那些局会永远卡在
   * awaiting_action（前端显示「飞行中」直到天荒地老）。
   */
  resumeTimelines(): number {
    const rows = all<RoundRow>(
      this.db,
      "SELECT * FROM rounds WHERE status = 'awaiting_action'",
    );
    let resumed = 0;
    for (const row of rows) {
      const game = this.games.get(row.game_id);
      if (!game?.timeline) continue;
      const state = JSON.parse(row.state) as unknown;
      if (game.timeline(state).length === 0) continue;
      // started_at 是 SQLite 的 UTC 文本（'YYYY-MM-DD HH:MM:SS'）
      const startedMs = Date.parse(`${row.started_at.replace(' ', 'T')}Z`);
      const elapsed = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0;
      this.armTimeline(row.id, game, state, elapsed);
      resumed += 1;
    }
    return resumed;
  }

  /** 收摊：撤掉所有还在等的定时器，否则进程退不出去 */
  disposeTimelines(): void {
    for (const roundId of [...this.timers.keys()]) this.clearTimeline(roundId);
    for (const h of [...this.broadcastTimers]) clearTimeout(h);
    this.broadcastTimers.clear();
  }

  // ── 结算 ─────────────────────────────────────────────────────

  private settleInner(
    sink: ServerFrame[],
    round: RoundRow,
    game: GameModule<any>,
    state: unknown,
    actor: string,
  ): {
    payoutCents: Cents;
    stakedCents: Cents;
    netCents: Cents;
    balanceAfter: Cents;
    breakdown: Record<string, unknown>;
  } {
    const result = game.settle(state);
    const payoutCents = result.payoutCents;
    const stakedCents = result.stakedCents;
    const netCents = payoutCents - stakedCents;
    const breakdown = { ...result.breakdown, stakedCents };

    let balanceAfter: Cents;
    if (payoutCents > 0) {
      balanceAfter = this.wallets.applyInner({
        walletId: round.wallet_id,
        kind: 'payout',
        deltaCents: payoutCents,
        roundId: round.id,
        idemKey: `r${round.id}:payout`,
      }).balanceAfter;
    } else {
      balanceAfter = this.wallets.getOrThrow(round.wallet_id).balance_cents;
    }

    run(
      this.db,
      `UPDATE rounds
          SET status = 'settled', payout_cents = ?, net_cents = ?, settled_at = datetime('now')
        WHERE id = ?`,
      payoutCents,
      netCents,
      round.id,
    );

    sink.push({
      type: 'round_settled',
      roundId: round.id,
      tableId: round.table_id,
      gameId: round.game_id as GameId,
      walletId: round.wallet_id,
      status: 'settled',
      payoutCents,
      netCents,
      balanceAfter,
      // 结算后的权威局面：事件流推不回来的终局（如德州扑克的庄家底牌）只能靠它
      view: game.publicView(state),
      // 结算后才揭示种子，供任何人验算
      serverSeed: round.server_seed ?? '',
      breakdown,
      atMs: 0,
    });

    // 派彩单独推一条钱包帧。前端靠 wallet_update 更新余额条，
    // round_settled 里那个 balanceAfter 它不认 —— 少了这一条，
    // 一直开着页面的观众看到的余额永远是「下注后」的数字（少了派彩）。
    if (payoutCents > 0) {
      sink.push({
        type: 'wallet_update',
        walletId: round.wallet_id,
        balanceCents: balanceAfter,
        deltaCents: payoutCents,
        reason: 'payout',
        atMs: 0,
      });
    }

    return { payoutCents, stakedCents, netCents, balanceAfter, breakdown };
  }

  /**
   * 游戏要求追加注额时（黑杰克加倍、分牌…）额外扣钱并记流水。
   * 幂等键是「局号 + 步骤号」，重试不会重复扣。
   */
  private chargeExtraStake(
    sink: ServerFrame[],
    roundId: number,
    walletId: number,
    step: { stakeDeltaCents?: number },
    stepIndex: number,
    fallbackBalance: Cents,
  ): Cents {
    const delta = step.stakeDeltaCents ?? 0;
    if (delta <= 0) return fallbackBalance;

    const res = this.wallets.applyInner({
      walletId,
      kind: 'bet',
      deltaCents: -delta,
      roundId,
      idemKey: `r${roundId}:stake:${stepIndex}`,
    });

    sink.push({
      type: 'wallet_update',
      walletId,
      balanceCents: res.balanceAfter,
      deltaCents: -delta,
      reason: 'extra_stake',
      atMs: 0,
    });

    return res.balanceAfter;
  }

  // ── 事件落库 ─────────────────────────────────────────────────

  private persistEvents(
    sink: ServerFrame[],
    roundId: number,
    tableId: string,
    gameId: string,
    actor: string,
    events: GameEventDraft[],
  ): void {
    let t = Number(
      one<{ m: number | null }>(
        this.db,
        'SELECT MAX(at_ms) AS m FROM round_events WHERE round_id = ?',
        roundId,
      )?.m ?? 0,
    );
    let seq = Number(
      one<{ m: number | null }>(
        this.db,
        'SELECT MAX(seq) AS m FROM round_events WHERE round_id = ?',
        roundId,
      )?.m ?? 0,
    );

    for (const e of events) {
      t += e.delayMs ?? 0;
      seq += 1;
      const payload = e.payload ?? {};
      run(
        this.db,
        `INSERT INTO round_events (round_id, seq, actor, type, payload, at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        roundId,
        seq,
        actor,
        e.type,
        JSON.stringify(payload),
        t,
      );
      sink.push({
        type: 'round_event',
        roundId,
        tableId,
        gameId: gameId as GameId,
        seq,
        actor,
        eventType: e.type,
        payload,
        atMs: t,
      });
    }
  }

  // ── 查询 ─────────────────────────────────────────────────────

  getRoundRow(id: number): RoundRow {
    const row = one<RoundRow>(this.db, 'SELECT * FROM rounds WHERE id = ?', id);
    if (!row) throw new PlaygroundError('ROUND_NOT_FOUND', `对局不存在: ${id}`, 404);
    return row;
  }

  getRound(id: number): PublicRound {
    return this.toPublicRound(this.getRoundRow(id));
  }

  /** 把内部行转成对外快照——这里是把「隐藏信息」挡在门外的最后一道关卡 */
  toPublicRound(round: RoundRow): PublicRound {
    const game = this.games.require(round.game_id);
    const revealed = round.status === 'settled' || round.status === 'timed_out';
    return {
      id: round.id,
      gameId: round.game_id,
      tableId: round.table_id,
      walletId: round.wallet_id,
      betCents: round.bet_cents,
      status: round.status,
      payoutCents: round.payout_cents,
      netCents: round.net_cents,
      seedCommit: round.seed_commit,
      serverSeed: revealed ? round.server_seed : null,
      clientSeed: round.client_seed,
      nonce: round.nonce,
      startedAt: round.started_at,
      settledAt: round.settled_at,
      view: game.publicView(JSON.parse(round.state)),
    };
  }

  events(roundId: number) {
    return all<RoundEventRow>(
      this.db,
      'SELECT * FROM round_events WHERE round_id = ? ORDER BY seq ASC',
      roundId,
    ).map((e) => ({
      seq: e.seq,
      actor: e.actor,
      type: e.type,
      payload: JSON.parse(e.payload) as Record<string, unknown>,
      atMs: e.at_ms,
    }));
  }

  recentRounds(limit = 30, walletId?: number): PublicRound[] {
    const rows = walletId
      ? all<RoundRow>(
          this.db,
          'SELECT * FROM rounds WHERE wallet_id = ? ORDER BY id DESC LIMIT ?',
          walletId,
          limit,
        )
      : all<RoundRow>(this.db, 'SELECT * FROM rounds ORDER BY id DESC LIMIT ?', limit);
    return rows.map((r) => this.toPublicRound(r));
  }

  tables(): TableSummary[] {
    const rows = all<{
      table_id: string;
      game_id: string;
      players: number;
      last_activity: string | null;
      open_rounds: number;
    }>(
      this.db,
      `SELECT table_id,
              game_id,
              COUNT(DISTINCT wallet_id)                                AS players,
              MAX(started_at)                                          AS last_activity,
              SUM(CASE WHEN status = 'awaiting_action' THEN 1 ELSE 0 END) AS open_rounds
         FROM rounds
        GROUP BY table_id, game_id
        ORDER BY table_id ASC`,
    );
    return rows.map((r) => ({
      tableId: r.table_id,
      gameId: r.game_id,
      players: Number(r.players),
      lastActivity: r.last_activity,
      openRounds: Number(r.open_rounds),
    }));
  }

  // ── 公平性验证 ───────────────────────────────────────────────

  /** 任何人都可以用这个接口复算：公布的种子是否真的对应开局时那个哈希 */
  verifyRound(roundId: number) {
    const r = this.getRoundRow(roundId);
    if (r.status !== 'settled') {
      throw new PlaygroundError('ROUND_NOT_OPEN', '这一局还没结算，种子尚未揭示', 409);
    }
    const serverSeed = r.server_seed ?? '';
    return {
      roundId: r.id,
      gameId: r.game_id,
      commit: r.seed_commit,
      serverSeed,
      clientSeed: r.client_seed,
      nonce: r.nonce,
      ok: verifyCommit(serverSeed, r.seed_commit),
    };
  }
}
