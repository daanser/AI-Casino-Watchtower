/**
 * 并行运行器
 *
 * 每个 Bot 一个独立 async 循环，各带自己的节奏计时器。Bot 的 tableId 是固定槽位，
 * 选新游戏只更新该 Bot 的游戏标题和画面，不改变它在前端网格里的位置。
 *
 * 每个 Bot 每玩满三局（或连续输三局）会按自己的策略重新挑游戏；如果切换，
 * 必须先发醒目的 game_switch 广播，再把理由落入下一局的事件流。
 */

import { coins, type Cents, type GameId } from '@ai-gaming/shared';
import type { RoundService, WalletService } from '@ai-gaming/core';
import {
  SCRIPTED_BOTS,
  actOtherGame,
  chooseBotGame,
  openOtherGame,
  type BotContext,
  type ScriptedBot,
} from './scripted';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
/** 花旗骰和高低猜是多步回合；避免长回合被过早遗弃 */
const MAX_STEPS_PER_ROUND = 128;

export interface RunnerOptions {
  speed?: number;
  reliefCents?: Cents;
  onLog?: (msg: string) => void;
}

export interface BotStatus {
  id: string;
  displayName: string;
  persona: string;
  /** 固定槽位 id，例如 bot-alpha；游戏切换时不变 */
  tableId: string;
  gameId: string;
  walletId: number | null;
  rounds: number;
  wins: number;
  netCents: Cents;
  lastReasoning: string | null;
  running: boolean;
}

export class PlaygroundRunner {
  private stopped = false;
  private readonly loops: Promise<void>[] = [];
  private readonly stats = new Map<string, BotStatus>();
  private readonly log: (msg: string) => void;

  constructor(
    private readonly rounds: RoundService,
    private readonly wallets: WalletService,
    private readonly opts: RunnerOptions = {},
  ) {
    this.log = opts.onLog ?? (() => {});
  }

  ensureWallets(bots: ScriptedBot[] = SCRIPTED_BOTS): Map<string, number> {
    const map = new Map<string, number>();
    for (const bot of bots) {
      let wallet = this.wallets.getByOwner('agent', bot.id);
      if (!wallet) {
        wallet = this.wallets.create({
          ownerType: 'agent',
          ownerId: bot.id,
          displayName: bot.displayName,
          initialCents: bot.bankrollCents,
        });
      }
      map.set(bot.id, wallet.id);
    }
    return map;
  }

  start(bots: ScriptedBot[] = SCRIPTED_BOTS): void {
    if (this.loops.length > 0) return;
    this.stopped = false;
    const walletIds = this.ensureWallets(bots);

    for (const bot of bots) {
      const walletId = walletIds.get(bot.id);
      if (walletId === undefined) continue;
      this.stats.set(bot.id, {
        id: bot.id,
        displayName: bot.displayName,
        persona: bot.persona,
        tableId: bot.tableId,
        gameId: bot.gameId,
        walletId,
        rounds: 0,
        wins: 0,
        netCents: 0,
        lastReasoning: null,
        running: true,
      });
      this.loops.push(this.loop(bot, walletId));
    }

    this.log(`${bots.length} 个脚本 Bot 已上场：${bots.map((b) => b.displayName).join(' · ')}`);
  }

  stop(): void {
    this.stopped = true;
    for (const st of this.stats.values()) st.running = false;
  }

  status(): BotStatus[] {
    return [...this.stats.values()];
  }

  private async loop(bot: ScriptedBot, walletId: number): Promise<void> {
    const recentNet: Cents[] = [];
    let roundIndex = 0;
    let currentGameId = bot.gameId as GameId;
    const speed = this.opts.speed ?? 1;
    const relief = this.opts.reliefCents ?? coins(500);

    while (!this.stopped) {
      try {
        let wallet = this.wallets.getOrThrow(walletId);
        let cfg = this.rounds.config(currentGameId);
        const choiceCtx: BotContext = {
          balanceCents: wallet.balance_cents,
          recentNet,
          minBetCents: cfg.min_bet_cents,
          roundIndex,
        };
        const choice = chooseBotGame(bot, choiceCtx, currentGameId);

        if (choice.gameId !== currentGameId) {
          const fromGameId = currentGameId;
          currentGameId = choice.gameId;
          this.rounds.announceGameSwitch({
            botId: bot.id,
            displayName: bot.displayName,
            tableId: bot.tableId,
            fromGameId,
            toGameId: currentGameId,
            reason: choice.reason,
          });
          const st = this.stats.get(bot.id);
          if (st) st.gameId = currentGameId;
          this.log(`[${bot.displayName}] 切换游戏：${fromGameId} → ${currentGameId}；原因：${choice.reason}`);
          await sleep(900 * speed);
        }

        cfg = this.rounds.config(currentGameId);
        wallet = this.wallets.getOrThrow(walletId);
        if (wallet.balance_cents < cfg.min_bet_cents * 3) {
          this.wallets.apply({
            walletId,
            kind: 'relief',
            deltaCents: relief,
            idemKey: `relief:${walletId}:${Date.now()}`,
          });
          this.log(`[${bot.displayName}] 余额见底，发放救济 ${relief / 100} 筹码`);
          await sleep(800 * speed);
          continue;
        }

        const ctx: BotContext = {
          balanceCents: wallet.balance_cents,
          recentNet,
          minBetCents: cfg.min_bet_cents,
          roundIndex,
        };
        const open = currentGameId === bot.gameId ? bot.open(ctx) : openOtherGame(bot, currentGameId, ctx);
        const cap = Math.min(cfg.max_bet_cents, Math.floor(wallet.balance_cents / 3));
        const betCents = Math.max(cfg.min_bet_cents, Math.min(open.betCents, cap));

        let current = await this.rounds.start({
          walletId,
          gameId: currentGameId,
          betCents,
          params: open.params,
          tableId: bot.tableId,
          actor: bot.id,
          reasoning: open.reasoning,
        });

        await sleep(bot.paceMs * 0.3 * speed);
        let lastReasoning = open.reasoning;
        let guard = 0;
        while (current.status === 'awaiting_action' && guard < MAX_STEPS_PER_ROUND && !this.stopped) {
          guard += 1;
          const decision = currentGameId === bot.gameId
            ? bot.act(current.view, ctx)
            : actOtherGame(bot, currentGameId, current.view, ctx);
          if (!decision) break;
          if (decision.waitBeforeMs && decision.waitBeforeMs > 0) await sleep(decision.waitBeforeMs * speed + 250);

          const res = await this.rounds.act(current.id, decision.action, {
            reasoning: decision.reasoning || undefined,
            actor: bot.id,
          });
          current = res.round;
          if (decision.reasoning) lastReasoning = decision.reasoning;
          if (current.status === 'awaiting_action') await sleep(bot.paceMs * 0.5 * speed);
        }

        if (current.status === 'awaiting_action') {
          // 被 stop() 打断时这一局本来就还没走完，不是「卡住」，不要误报
          if (this.stopped) break;
          this.log(`[${bot.displayName}] 一局超过 ${MAX_STEPS_PER_ROUND} 步仍未结束`);
          await sleep(1000 * speed);
          continue;
        }

        recentNet.push(current.netCents);
        if (recentNet.length > 10) recentNet.shift();
        const st = this.stats.get(bot.id);
        if (st) {
          st.rounds += 1;
          if (current.netCents > 0) st.wins += 1;
          st.netCents += current.netCents;
          st.lastReasoning = lastReasoning;
          st.gameId = currentGameId;
        }
        roundIndex += 1;
        await sleep(bot.paceMs * 0.5 * speed);
      } catch (err) {
        this.log(`[${bot.displayName}] 出错：${(err as Error).message}`);
        await sleep(1500);
      }
    }
  }
}
