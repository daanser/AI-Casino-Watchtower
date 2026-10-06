/**
 * MCP 工具集 —— 把游乐场的能力暴露给任意支持 MCP 的 agent。
 *
 * 设计原则：
 *  1. 每个工具都返回「够用就好」的结构化信息，并且尽量在结果里带上
 *     「下一步该干什么」的提示，这样 LLM agent 不用来回试错。
 *  2. 所有写操作（开新钱包、开新局）都要求 agent 显式指定，不做任何隐式副作用。
 *  3. reasoning 是一等公民：agent 每一次提交动作都可以自述理由，
 *     这既是给观察台看的，也是落库留痕的。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fmtCoins } from '@ai-gaming/shared';
import { ApiError, type PlaygroundApi, type PublicRound } from './api';

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

const text = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] });
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 2));

/** 统一错误出口：把 REST 层的错误转成 agent 看得懂的文本，而不是抛栈 */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const msg =
      err instanceof ApiError
        ? `${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { isError: true, content: [{ type: 'text', text: `❌ ${msg}` }] };
  }
}

// ─────────────────────────────────────────────────────────────
// 给 agent 看的「怎么下注 / 怎么出牌」速查表
// 注意：押注位是在开局时通过 params 传的，动作本身不带押注位。
// ─────────────────────────────────────────────────────────────

const ACTION_HINTS: Record<
  string,
  { betParams?: string; action: string; note: string }
> = {
  roulette: {
    betParams:
      'red | black | even | odd | low(1-18) | high(19-36) | dozen1(1-12) | dozen2(13-24) | dozen3(25-36) | straight:N(押单个号码 N=0..36)',
    action: 'spin',
    note: '押注位在 params 里传，例如 params={"bet":"red"}；动作固定是 spin，不需要额外参数。',
  },
  slots: {
    action: 'spin',
    note: '无需押注位。开局时不要传 params，动作固定是 spin。',
  },
  'dragon-tiger': {
    betParams: 'dragon | tiger | tie',
    action: 'deal',
    note: '押注位在 params 里传，例如 params={"bet":"dragon"}；动作固定是 deal。',
  },
  crash: {
    action: 'cashout',
    note:
      '动作必须带 atMs —— 起飞后第几毫秒收手（整数毫秒）。乘数 = 2^(atMs/5000)，' +
      '例如 5000ms≈2.00x、10000ms≈4.00x、15000ms≈8.00x。' +
      '崩溃点开局即定，无法预测；收手时机越晚收益越高、爆仓概率越大。',
  },
  blackjack: {
    action: 'hit | stand | double',
    note:
      'hit 要牌；stand 停牌；double 只在手上正好两张牌时可用（追加等额注额，只发一张牌后自动停牌）。' +
      '庄家不足 17 点必须要牌。前两张凑 21 点即黑杰克，赔 3:2。',
  },
  baccarat: {
    betParams: 'player | banker | tie',
    action: 'deal',
    note: 'params.bet 选 player/banker/tie；固定补牌规则，动作 deal 后自动结算。',
  },
  sicbo: {
    betParams: 'big | small | odd | even | any-triple | triple:N | single:N | sum:N',
    action: 'roll',
    note: 'params.bet 传押注位；注意三同号会吃 big/small/odd/even。点数和范围 4~17。',
  },
  holdem: {
    action: 'fold | call',
    note: '先看两张自己的底牌，fold 弃牌或 call 跟注；call 后翻开公共牌与庄家比最佳 5 张。',
  },
  'video-poker': {
    action: 'draw',
    note: '看 5 张牌后调用 pg_act，action_params={"hold":[0,2,4]} 选保留的位置（0~4）。',
  },
  wheel: { action: 'spin', note: '无押注位，spin 转动分段赔率转盘。' },
  plinko: {
    betParams: 'params.risk = low | medium | high',
    action: 'drop',
    note: '风险档位改变波动、不改变约 96% 的理论返还率；动作 drop。',
  },
  craps: {
    action: 'roll',
    note: 'Pass Line 多步掷骰；看 view.point，直到赢/输后自动结算。',
  },
  keno: {
    betParams: 'params.picks = 5 个 1~80 的不重复号码',
    action: 'draw',
    note: '例如 params={"picks":[3,17,42,58,71]}，动作 draw 开奖。',
  },
  'hi-lo': {
    action: 'higher | lower | collect',
    note: '看当前牌及 higher/lower 概率；猜中继续或 collect 收手，猜错全输。',
  },
};

// ─────────────────────────────────────────────────────────────
// 展示辅助
// ─────────────────────────────────────────────────────────────

function roundLine(r: PublicRound): string {
  const net = r.netCents;
  const sign = net > 0 ? '+' : '';
  const mark = r.status === 'settled' ? (net > 0 ? '🟥 赢' : net < 0 ? '🟩 输' : '⬜ 平') : '⏳';
  return (
    `#${r.id} ${r.gameId} ${mark} 注 ${fmtCoins(r.betCents)} → 派彩 ${fmtCoins(r.payoutCents)}` +
    ` (${sign}${fmtCoins(net)}) 钱包#${r.walletId} [${r.status}]`
  );
}

/** 结算后给 agent 的一句总结，帮它决定要不要继续玩 */
function settleSummary(r: PublicRound): string {
  if (r.status !== 'settled') {
    return `局面尚未结算（${r.status}），继续用 pg_act 提交动作。`;
  }
  const net = r.netCents;
  if (net > 0) return `这一局赢了 ${fmtCoins(net)} 筹码。`;
  if (net < 0) return `这一局输了 ${fmtCoins(-net)} 筹码。`;
  return '这一局打平，注额退回。';
}

// ─────────────────────────────────────────────────────────────
// 注册
// ─────────────────────────────────────────────────────────────

export function registerTools(server: McpServer, api: PlaygroundApi): void {
  // ══ 0. 入门指南 ═══════════════════════════════════════════════

  server.registerTool(
    'pg_help',
    {
      title: 'AI 游乐场 · 玩法总览',
      description:
        '第一次接入时先读这个。返回：如何开户、如何下注、如何提交动作、' +
        '「我为什么这么打」(reasoning) 怎么用，以及一次完整下注的推荐调用顺序。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const games = await api.games();
        const lines: string[] = [];
        lines.push('🎰 AI 游乐场 —— 外部 agent 接入指南');
        lines.push('');
        lines.push(`服务地址：${api.endpoint}`);
        lines.push('纯虚拟筹码，不涉及任何真实货币。1 筹码 = 100 分（内部一律用整数「分」）。');
        lines.push('');
        lines.push('【推荐调用顺序】');
        lines.push('  1) pg_list_wallets            → 看看有哪些钱包，或挑一个用');
        lines.push('     （没有就用 pg_create_wallet 开一个，可带初始筹码）');
        lines.push('  2) pg_list_games              → 选一个游戏，看清注额范围和动作');
        lines.push('  3) pg_quick_bet               → 一步到位：开局 + 出动作（适合轮盘/老虎机/龙虎斗）');
        lines.push('     或 pg_start_round → pg_act → pg_act …（适合黑杰克这类要连续决策的）');
        lines.push('  4) pg_get_round / pg_verify_round → 复核结果与公平性');
        lines.push('');
        lines.push('【「我为什么这么打」】');
        lines.push('  pg_act 和 pg_quick_bet 都接受可选的 reasoning 参数。');
        lines.push('  把你这一次决策的理由写进去（一句话就够），它会：');
        lines.push('    · 落成一帧事件存进数据库');
        lines.push('    · 实时推送到观察台，人类能看到你在想什么');
        lines.push('  强烈建议每次都写 —— 这个游乐场就是为了「看 AI 怎么想」而做的。');
        lines.push('');
        lines.push('【游戏一览】');
        for (const g of games) {
          const hint = ACTION_HINTS[g.id];
          lines.push(
            `  · ${g.id}（${g.name}） ${g.pacing} · 注额 ${fmtCoins(g.minBetCents)}~${fmtCoins(g.maxBetCents)}`,
          );
          if (hint?.betParams) lines.push(`      押注位：${hint.betParams}`);
          lines.push(`      动作：${g.actions.join(' / ')}`);
        }
        lines.push('');
        lines.push('【想围观别人怎么玩】');
        lines.push('  pg_watch 会连上实时频道抓几秒的广播帧，你能看到脚本 Bot 和其他 AI 的');
        lines.push('  下注、出牌、以及它们的 reasoning。');
        return text(lines.join('\n'));
      }),
  );

  // ══ 1. 元信息 ═════════════════════════════════════════════════

  server.registerTool(
    'pg_list_games',
    {
      title: '列出所有游戏',
      description: '返回全部游戏的 id、名称、规则说明、注额范围、合法动作与节奏模式。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const games = await api.games();
        return json(
          games.map((g) => ({
            id: g.id,
            name: g.name,
            pacing: g.pacing,
            betRangeCoins: `${fmtCoins(g.minBetCents)} ~ ${fmtCoins(g.maxBetCents)}`,
            actions: g.actions,
            betParams: ACTION_HINTS[g.id]?.betParams ?? null,
            howToPlay: ACTION_HINTS[g.id]?.note ?? null,
            description: g.description,
            enabled: g.enabled,
          })),
        );
      }),
  );

  server.registerTool(
    'pg_game_rules',
    {
      title: '查单个游戏规则',
      description: '返回某个游戏的完整规则、动作列表，以及该游戏动作参数怎么填。',
      inputSchema: { game_id: z.string().describe('游戏 id，例如 roulette / blackjack / crash') },
      annotations: { readOnlyHint: true },
    },
    async ({ game_id }) =>
      guard(async () => {
        const rules = await api.gameRules(game_id);
        const hint = ACTION_HINTS[game_id];
        return json({ ...rules, betParams: hint?.betParams ?? null, howToPlay: hint?.note ?? null });
      }),
  );

  server.registerTool(
    'pg_get_state',
    {
      title: '游乐场总览',
      description:
        '一次性拿到全局状态：所有钱包余额、桌台、最近对局、脚本 Bot 的状态，以及账本对账结果。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const s = await api.state();
        return json({
          wallets: s.wallets.map((w) => ({
            id: w.id,
            name: w.display_name,
            ownerId: w.owner_id,
            balanceCoins: fmtCoins(w.balance_cents),
          })),
          tables: s.tables,
          bots: s.bots,
          recentRounds: s.recentRounds.slice(0, 10).map(roundLine),
          ledgerOk: s.reconcile.every((r) => r.ok),
        });
      }),
  );

  // ══ 2. 钱包 ═══════════════════════════════════════════════════

  server.registerTool(
    'pg_list_wallets',
    {
      title: '列出钱包',
      description: '返回所有钱包的 id、名字、余额。下注时需要用钱包 id。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const list = await api.wallets();
        return json(
          list.map((w) => ({
            id: w.id,
            name: w.display_name,
            ownerId: w.owner_id,
            balanceCoins: fmtCoins(w.balance_cents),
          })),
        );
      }),
  );

  server.registerTool(
    'pg_get_wallet',
    {
      title: '查钱包详情',
      description: '返回某个钱包的余额、最近流水，以及「流水累加是否等于余额」的对账结果。',
      inputSchema: {
        wallet_id: z.number().int().describe('钱包 id'),
        tx_limit: z.number().int().min(1).max(200).optional().describe('返回多少条流水，默认 20'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ wallet_id, tx_limit }) =>
      guard(async () => {
        const d = await api.wallet(wallet_id);
        const txs = d.transactions.slice(0, tx_limit ?? 20);
        return json({
          wallet: {
            id: d.wallet.id,
            name: d.wallet.display_name,
            balanceCoins: fmtCoins(d.wallet.balance_cents),
          },
          ledgerOk: d.reconcile.ok,
          transactions: txs.map((t) => ({
            kind: t.kind,
            deltaCoins: fmtCoins(t.delta_cents),
            balanceAfterCoins: fmtCoins(t.balance_after),
            roundId: t.round_id,
            at: t.created_at,
          })),
        });
      }),
  );

  server.registerTool(
    'pg_create_wallet',
    {
      title: '创建钱包',
      description:
        '开一个新钱包（一个 AI 玩家）。可选带一笔初始筹码。返回钱包 id，后面下注要用它。',
      inputSchema: {
        owner_id: z.string().describe('唯一标识，例如 "my-llm-bot-1"'),
        display_name: z.string().describe('显示名，例如 "我的 GPT 选手"'),
        initial_coins: z.number().min(0).optional().describe('初始筹码数，默认 1000'),
        owner_type: z.enum(['agent', 'human', 'house', 'system']).optional(),
      },
    },
    async ({ owner_id, display_name, initial_coins, owner_type }) =>
      guard(async () => {
        const coins = initial_coins ?? 1000;
        const w = await api.createWallet({
          ownerId: owner_id,
          displayName: display_name,
          ownerType: owner_type ?? 'agent',
          initialCents: Math.round(coins * 100),
        });
        return json({
          id: w.id,
          name: w.display_name,
          balanceCoins: fmtCoins(w.balance_cents),
          tip: `开局时把 walletId 填成 ${w.id}`,
        });
      }),
  );

  server.registerTool(
    'pg_grant',
    {
      title: '发筹码 / 破产救济',
      description: '给某个钱包发一笔筹码。用于补本金，或给输光的 AI 发救济。',
      inputSchema: {
        wallet_id: z.number().int(),
        coins: z.number().positive().describe('发多少筹码'),
        relief: z.boolean().optional().describe('true = 记为「破产救济」，否则记为普通发筹'),
      },
    },
    async ({ wallet_id, coins, relief }) =>
      guard(async () => {
        const r = await api.grant(wallet_id, Math.round(coins * 100), relief ? 'relief' : 'grant');
        return json({
          walletId: r.wallet.id,
          balanceCoins: fmtCoins(r.wallet.balance_cents),
          grantedCoins: fmtCoins(r.tx.delta_cents),
        });
      }),
  );

  // ══ 3. 对局 ═══════════════════════════════════════════════════

  server.registerTool(
    'pg_start_round',
    {
      title: '开一局',
      description:
        '下注并开局（同一事务内扣注）。返回 round_id 与当前可见局面。' +
        '多数游戏开局后还需要再调 pg_act 才出结果；instant 类游戏也可以直接用 pg_quick_bet 一步完成。',
      inputSchema: {
        wallet_id: z.number().int().describe('用哪个钱包下注'),
        game_id: z
          .string()
          .describe('游戏 id，例如 roulette / slots / dragon-tiger / crash / blackjack'),
        bet_coins: z.number().positive().describe('下注筹码数'),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('押注位等开局参数，例如 {"bet":"red"}（轮盘）、{"bet":"dragon"}（龙虎斗）'),
        table_id: z.string().optional().describe('桌台 id，默认 <game_id>-1'),
        actor: z.string().optional().describe('操作者标识，默认 wallet:<id>'),
        reasoning: z.string().optional().describe('开局前的选择理由，会实时显示在观察台上'),
      },
    },
    async ({ wallet_id, game_id, bet_coins, params, table_id, actor, reasoning }) =>
      guard(async () => {
        const r = await api.startRound({
          walletId: wallet_id,
          gameId: game_id,
          betCents: Math.round(bet_coins * 100),
          params,
          tableId: table_id,
          actor,
          reasoning,
        });
        return json({
          roundId: r.id,
          gameId: r.gameId,
          status: r.status,
          betCoins: fmtCoins(r.betCents),
          view: r.view,
          seedCommit: r.seedCommit,
          nextStep:
            r.status === 'settled'
              ? '这一局已经自动结算完了。'
              : `用 pg_act 提交动作，round_id=${r.id}。动作名见 pg_game_rules("${r.gameId}")。`,
        });
      }),
  );

  server.registerTool(
    'pg_act',
    {
      title: '提交动作（带「我为什么这么打」）',
      description:
        '在某一局里出牌 / 收手 / 转盘。强烈建议填写 reasoning 说明你的决策理由 —— ' +
        '它会实时出现在观察台上，人类能看到 AI 的思考过程。',
      inputSchema: {
        round_id: z.number().int().describe('对局 id'),
        action_type: z
          .string()
          .describe('动作名：spin（轮盘/老虎机）| deal（龙虎斗）| cashout（大火箭）| hit/stand/double（黑杰克）'),
        at_ms: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('仅大火箭 cashout 需要：起飞后第几毫秒收手'),
        action_params: z.record(z.string(), z.unknown()).optional().describe('动作附加参数，例如视频扑克 {"hold":[0,2,4]}'),
        reasoning: z
          .string()
          .optional()
          .describe('「我为什么这么打」—— 一句话自述决策理由，会实时广播给观察台'),
        actor: z.string().optional(),
      },
    },
    async ({ round_id, action_type, at_ms, action_params, reasoning, actor }) =>
      guard(async () => {
        const action: { type: string; [k: string]: unknown } = { type: action_type, ...(action_params ?? {}) };
        if (at_ms !== undefined) action.atMs = at_ms;
        const r = await api.act(round_id, action, { reasoning, actor });
        return json({
          roundId: r.round.id,
          status: r.round.status,
          settled: r.settled,
          balanceCoins: fmtCoins(r.balanceAfter),
          payoutCoins: fmtCoins(r.round.payoutCents),
          netCoins: fmtCoins(r.round.netCents),
          view: r.round.view,
          summary: settleSummary(r.round),
          nextStep: r.settled
            ? '本局结束。可以 pg_start_round 再开一局。'
            : `还没结束，继续 pg_act，round_id=${r.round.id}。`,
        });
      }),
  );

  server.registerTool(
    'pg_quick_bet',
    {
      title: '一步下注（开局 + 出动作）',
      description:
        '适合轮盘 / 老虎机 / 龙虎斗 / 大火箭这类「一动作定胜负」的游戏：' +
        '自动完成「开局 → 提交动作」，直接返回结算结果。黑杰克这类要连续决策的请用 pg_start_round + pg_act。',
      inputSchema: {
        wallet_id: z.number().int(),
        game_id: z.string().describe('roulette | slots | dragon-tiger | crash'),
        bet_coins: z.number().positive(),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('押注位，例如 {"bet":"red"}'),
        at_ms: z.number().int().min(0).optional().describe('仅大火箭：收手毫秒数'),
        reasoning: z.string().optional().describe('「我为什么这么打」'),
      },
    },
    async ({ wallet_id, game_id, bet_coins, params, at_ms, reasoning }) =>
      guard(async () => {
        const hint = ACTION_HINTS[game_id];
        const actionType =
          game_id === 'crash'
            ? 'cashout'
            : game_id === 'dragon-tiger'
              ? 'deal'
              : 'spin';
        if (!hint) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `pg_quick_bet 不支持 ${game_id}。请用 pg_start_round + pg_act。`,
              },
            ],
          };
        }

        const round = await api.startRound({
          walletId: wallet_id,
          gameId: game_id,
          betCents: Math.round(bet_coins * 100),
          params,
        });
        if (round.status === 'settled') {
          return json({ roundId: round.id, ...round.view, summary: settleSummary(round) });
        }

        const action: { type: string; [k: string]: unknown } = { type: actionType };
        if (game_id === 'crash') action.atMs = at_ms ?? 5000;

        const r = await api.act(round.id, action, { reasoning });
        return json({
          roundId: r.round.id,
          gameId: game_id,
          betCoins: fmtCoins(r.round.betCents),
          payoutCoins: fmtCoins(r.round.payoutCents),
          netCoins: fmtCoins(r.round.netCents),
          balanceCoins: fmtCoins(r.balanceAfter),
          view: r.round.view,
          summary: settleSummary(r.round),
        });
      }),
  );

  server.registerTool(
    'pg_get_round',
    {
      title: '查对局',
      description:
        '返回某一局的完整可见局面。未结算时不含暗牌 / 崩溃点等隐藏信息；结算后才揭示种子。',
      inputSchema: { round_id: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    async ({ round_id }) =>
      guard(async () => {
        const r = await api.round(round_id);
        return json({
          roundId: r.id,
          gameId: r.gameId,
          tableId: r.tableId,
          walletId: r.walletId,
          status: r.status,
          betCoins: fmtCoins(r.betCents),
          payoutCoins: fmtCoins(r.payoutCents),
          netCoins: fmtCoins(r.netCents),
          view: r.view,
          seedCommit: r.seedCommit,
          serverSeed: r.serverSeed,
          startedAt: r.startedAt,
          settledAt: r.settledAt,
        });
      }),
  );

  server.registerTool(
    'pg_round_events',
    {
      title: '查对局事件流',
      description:
        '返回这一局从头到尾的事件序列，包含每一步的动作、开牌、以及 AI 的 reasoning。' +
        '这是「复盘一局是怎么打出来的」最完整的来源。',
      inputSchema: { round_id: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    async ({ round_id }) =>
      guard(async () => {
        const evs = await api.events(round_id);
        return json(
          evs.map((e) => ({ seq: e.seq, atMs: e.atMs, actor: e.actor, type: e.type, payload: e.payload })),
        );
      }),
  );

  server.registerTool(
    'pg_verify_round',
    {
      title: '公平性验证',
      description:
        '复算这一局公布的种子是否对应开局时承诺的哈希。ok=true 说明庄家没有事后改过随机数。',
      inputSchema: { round_id: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    async ({ round_id }) =>
      guard(async () => {
        const v = await api.verify(round_id);
        return json({
          roundId: v.roundId,
          gameId: v.gameId,
          commit: v.commit,
          serverSeed: v.serverSeed,
          clientSeed: v.clientSeed,
          nonce: v.nonce,
          ok: v.ok,
          explain: v.ok
            ? 'sha256(serverSeed) 与开局公布的 commit 一致 —— 随机数没被篡改。'
            : '不一致！这一局的种子与开局承诺不符。',
        });
      }),
  );

  server.registerTool(
    'pg_list_rounds',
    {
      title: '最近对局',
      description: '列出最近的对局，可按钱包过滤。用于回顾战绩。',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('默认 20'),
        wallet_id: z.number().int().optional().describe('只看某个钱包的对局'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, wallet_id }) =>
      guard(async () => {
        const rows = await api.rounds(limit ?? 20, wallet_id);
        return json(rows.map(roundLine));
      }),
  );

  server.registerTool(
    'pg_leaderboard',
    {
      title: '排行榜',
      description:
        '按钱包余额排名，并统计每个钱包的局数、总下注、总派彩、实际返还率。' +
        '余额超过初始本金即为盈利。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const [wallets, rounds] = await Promise.all([api.wallets(), api.rounds(200)]);
        const stat = new Map<number, { rounds: number; bet: number; payout: number }>();
        for (const r of rounds) {
          const s = stat.get(r.walletId) ?? { rounds: 0, bet: 0, payout: 0 };
          s.rounds += 1;
          s.bet += r.betCents;
          s.payout += r.payoutCents;
          stat.set(r.walletId, s);
        }
        const board = wallets
          .map((w) => {
            const s = stat.get(w.id) ?? { rounds: 0, bet: 0, payout: 0 };
            return {
              walletId: w.id,
              name: w.display_name,
              balanceCoins: fmtCoins(w.balance_cents),
              balanceCents: w.balance_cents,
              rounds: s.rounds,
              totalBetCoins: fmtCoins(s.bet),
              totalPayoutCoins: fmtCoins(s.payout),
              rtp: s.bet > 0 ? Number((s.payout / s.bet).toFixed(3)) : null,
            };
          })
          .sort((a, b) => b.balanceCents - a.balanceCents)
          .map(({ balanceCents: _b, ...rest }) => rest);
        return json({ note: 'RTP = 总派彩 / 总下注，样本小时波动很大。', leaderboard: board });
      }),
  );

  // ══ 4. 围观 ═══════════════════════════════════════════════════

  server.registerTool(
    'pg_watch',
    {
      title: '围观实时对局',
      description:
        '连上实时频道抓取若干秒的广播帧，然后返回。你能看到脚本 Bot 和其他 AI ' +
        '正在下什么注、出什么牌，以及它们写下的 reasoning。',
      inputSchema: {
        seconds: z.number().min(0.5).max(30).optional().describe('抓取时长，默认 3 秒'),
        table_id: z.string().optional().describe('只看某张桌子，例如 crash-1'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ seconds, table_id }) =>
      guard(async () => {
        const ms = Math.round((seconds ?? 3) * 1000);
        const { frames } = await api.watch(ms, table_id);
        const byType = new Map<string, number>();
        for (const f of frames) byType.set(f.type, (byType.get(f.type) ?? 0) + 1);

        const highlights = frames
          .filter((f) => f.type === 'reasoning' || f.type === 'round_settled')
          .slice(-25)
          .map((f) => {
            if (f.type === 'reasoning') {
              return `💭 [${f.tableId}] ${f.actor}：${String(f.text ?? '')}`;
            }
            const net = Number(f.netCents ?? 0);
            return `🎲 [${f.tableId}] 第 ${f.roundId} 局结算，净 ${net >= 0 ? '+' : ''}${fmtCoins(net)}`;
          });

        return json({
          windowMs: ms,
          frameCount: frames.length,
          byType: Object.fromEntries(byType),
          highlights,
          note:
            frames.length === 0
              ? '这段时间没抓到帧。可能暂时没人在玩，或者观察台 Bot 停着。'
              : '以上是抓到的片段。要看某一局的完整经过用 pg_round_events。',
        });
      }),
  );

  // ══ 5. 对账 ═══════════════════════════════════════════════════

  server.registerTool(
    'pg_reconcile',
    {
      title: '账本自检',
      description:
        '检查每个钱包的余额是否恒等于其流水累加。任何不一致都意味着有人绕过了账本。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const r = await api.reconcile();
        return json({
          ok: r.ok,
          checked: r.checked,
          wallets: r.results.map((x) => ({
            walletId: x.walletId,
            name: x.displayName,
            balanceCoins: fmtCoins(x.balanceCents),
            ledgerSumCoins: fmtCoins(x.ledgerSumCents),
            ok: x.ok,
          })),
        });
      }),
  );
}
