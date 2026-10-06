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
import type { GameAction, GameEventDraft, GameModule, SettleResult } from './games/types';

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

      let balanceAfter = this.chargeExtraStake(
        sink,
        roundId,
        input.walletId,
        step,
        0,
        debit.balanceAfter,
      );
      let settled: SettleResult | null = null;

      if (step.done) {
        const round = this.getRoundRow(roundId);
        const info = this.settleInner(sink, round, game, step.state, actor);
        balanceAfter = info.balanceAfter;
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
      sink.push({
        type: 'wallet_update',
        walletId: input.walletId,
        balanceCents: balanceAfter,
        deltaCents: settled ? settled.payoutCents - input.betCents : -input.betCents,
        reason: settled ? 'bet+payout' : 'bet',
        atMs: 0,
      });

      return { roundId };
    });

    // COMMIT 成功之后才广播
    for (const frame of sink) this.bus.publish(frame);
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

    for (const frame of sink) this.bus.publish(frame);

    return {
      round: this.toPublicRound(this.getRoundRow(roundId)),
      balanceAfter: out.balanceAfter,
      settled: out.settled,
    };
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
      // 结算后才揭示种子，供任何人验算
      serverSeed: round.server_seed ?? '',
      breakdown,
      atMs: 0,
    });

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
