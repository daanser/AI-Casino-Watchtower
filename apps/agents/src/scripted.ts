/**
 * 内置脚本 Bot —— 零成本、行为可预测的对照组。
 * 有固定人格与主场，但现在会自己在全部 14 款游戏之间做选择。
 */

import { coins, GAME_IDS, type Cents, type GameId } from '@ai-gaming/shared';
import { msForMultiplier } from '@ai-gaming/core';

export interface BotContext {
  balanceCents: Cents;
  recentNet: Cents[];
  minBetCents: Cents;
  roundIndex: number;
}

export interface OpenDecision {
  params: Record<string, unknown>;
  betCents: Cents;
  reasoning: string;
}

export interface ActionDecision {
  action: { type: string; [k: string]: unknown };
  reasoning: string;
  waitBeforeMs?: number;
}

export interface ScriptedBot {
  id: string;
  displayName: string;
  persona: string;
  /** 固定槽位，游戏切换时绝不改变 */
  tableId: string;
  /** 原来的主场游戏 */
  gameId: string;
  paceMs: number;
  bankrollCents: Cents;
  open(ctx: BotContext): OpenDecision;
  act(view: Record<string, unknown>, ctx: BotContext): ActionDecision | null;
}

const trailingLosses = (recentNet: Cents[]): number => {
  let n = 0;
  for (let i = recentNet.length - 1; i >= 0; i -= 1) {
    if ((recentNet[i] as number) < 0) n += 1;
    else break;
  }
  return n;
};

const pick = (lines: string[], i: number): string => lines[i % lines.length] as string;

// ── 阿尔法 · 初始主场老虎机 ───────────────────────────────────
const ALPHA_LINES = [
  '三连 7️⃣ 返 150 倍。概率低不代表不会发生，我这叫小注博大。',
  '连输好几把了，机器该吐点东西出来了吧。',
  '我不信它一直不出 💎。再来。',
  '赔率表我背下来了，长期看是我赚——好吧，是庄家赚。',
  '这次感觉对了。真的。',
  '每把 10 筹码，输到 500 我就停。这是纪律。',
];

const alpha: ScriptedBot = {
  id: 'alpha',
  displayName: '阿尔法',
  persona: '死不认输的赌徒',
  tableId: 'bot-alpha',
  gameId: 'slots',
  paceMs: 2400,
  bankrollCents: coins(1000),
  open(ctx) {
    const losses = trailingLosses(ctx.recentNet);
    return { params: {}, betCents: losses >= 5 ? coins(20) : coins(10), reasoning: pick(ALPHA_LINES, ctx.roundIndex) };
  },
  act() { return { action: { type: 'spin' }, reasoning: '' }; },
};

// ── 贝塔 · 初始主场龙虎斗 ─────────────────────────────────────
const BETA_LINES = [
  '龙虎完全对称，各 46.3% 胜率，和局 7.47%。既然对称，我固定押龙，靠样本量说话。',
  '上一把输了不改变下一把的分布。赌徒谬误是散户的坟场。',
  '押龙。不是因为它该赢了，是因为押哪边都一样。',
  '8 副牌不放回，和局概率是 7.47%，不是 1/13。这种细节庄家从来不说。',
  'RTP 92.5%。长期我必输，我要做的只是把这个数字演示给你看。',
  '如果我一直押龙，方差会慢慢收窄，曲线会平滑地往下走。',
];

const beta: ScriptedBot = {
  id: 'beta',
  displayName: '贝塔',
  persona: '只信概率的数学派',
  tableId: 'bot-beta',
  gameId: 'dragon-tiger',
  paceMs: 3000,
  bankrollCents: coins(1000),
  open(ctx) { return { params: { bet: 'dragon' }, betCents: coins(20), reasoning: pick(BETA_LINES, ctx.roundIndex) }; },
  act() { return { action: { type: 'deal' }, reasoning: '' }; },
};

// ── 伽马 · 初始主场轮盘 ───────────────────────────────────────
const GAMMA_LINES = [
  '押 17。36 倍。我这辈子就等这一把。',
  '押单号的期望是负的，但我不在乎期望，我在乎赔率。',
  '17 是我生日。这不是策略，这是信仰。',
  '连输就加倍？不。加倍是给输不起的人准备的，我本来就输得起。',
  '0 通吃外围注——所以我不押外围，我押单号。',
  '每次 5 筹码，中一次回本 36 次。数学上我只需要中 1/37。',
];

const gamma: ScriptedBot = {
  id: 'gamma',
  displayName: '伽马',
  persona: '押单号的投机者',
  tableId: 'bot-gamma',
  gameId: 'roulette',
  paceMs: 2600,
  bankrollCents: coins(1000),
  open(ctx) { return { params: { bet: 'straight:17' }, betCents: coins(5), reasoning: pick(GAMMA_LINES, ctx.roundIndex) }; },
  act() { return { action: { type: 'spin' }, reasoning: '' }; },
};

// ── 德尔塔 · 初始主场大火箭 ───────────────────────────────────
const DELTA_TARGETS = [1.5, 1.2, 2.0, 1.5, 1.3, 1.8];
const delta: ScriptedBot = {
  id: 'delta',
  displayName: '德尔塔',
  persona: '见好就收的稳健派',
  tableId: 'bot-delta',
  gameId: 'crash',
  paceMs: 1500,
  bankrollCents: coins(1000),
  open(ctx) {
    const target = DELTA_TARGETS[ctx.roundIndex % DELTA_TARGETS.length] as number;
    return {
      params: {},
      betCents: coins(20),
      reasoning: `这把我打算在 ${target.toFixed(2)} 倍收手。崩溃点服从 P(崩溃点 ≥ m) = 0.97/m，所以收手点只影响方差。`,
    };
  },
  act(_view, ctx) {
    const target = DELTA_TARGETS[ctx.roundIndex % DELTA_TARGETS.length] as number;
    const atMs = msForMultiplier(target);
    return {
      action: { type: 'cashout', atMs },
      reasoning: pick([
        `飞 ${(atMs / 1000).toFixed(1)} 秒到 ${target.toFixed(2)} 倍，收。`,
        `目标 ${target.toFixed(2)} 倍。崩溃概率 ${((1 - 0.97 / target) * 100).toFixed(1)}%，我赌它不炸。`,
        `贪心的人死在 10 倍上，我只拿 ${target.toFixed(2)} 倍。`,
        '我不猜崩溃点，我只控制自己什么时候走。',
      ], ctx.roundIndex),
      waitBeforeMs: atMs,
    };
  },
};

// ── 艾普西隆 · 初始主场黑杰克 ─────────────────────────────────
const EPSILON_LINES = [
  '我不算牌。算牌需要记牌，而我没有记忆——我只有规则。',
  '基本策略很无聊，但无聊的策略最省钱。',
  '庄家不到 17 必须要牌，这是他的弱点，不是我的。',
];
const epsilon: ScriptedBot = {
  id: 'epsilon',
  displayName: '艾普西隆',
  persona: '照本宣科的机械派',
  tableId: 'bot-epsilon',
  gameId: 'blackjack',
  paceMs: 1600,
  bankrollCents: coins(1000),
  open(ctx) { return { params: {}, betCents: coins(25), reasoning: pick(EPSILON_LINES, ctx.roundIndex) }; },
  act(view) {
    const total = Number(view.playerTotal ?? 0);
    const actions = (view.actions as string[] | undefined) ?? [];
    const dealerUp = Array.isArray(view.dealer) && view.dealer[0]
      ? `${(view.dealer[0] as { rank: string; suit: string }).rank}${(view.dealer[0] as { rank: string; suit: string }).suit}`
      : '?';
    if (actions.includes('double') && (total === 10 || total === 11)) {
      return { action: { type: 'double' }, reasoning: `${total} 点，庄家明牌 ${dealerUp}。加倍是这一手的最优解。` };
    }
    if (total <= 16) return { action: { type: 'hit' }, reasoning: total <= 11 ? `${total} 点，怎么要都爆不了，没理由不要。` : `${total} 点，再要一张。` };
    return { action: { type: 'stand' }, reasoning: `${total} 点，停。剩下交给庄家自己爆。` };
  },
};

export const SCRIPTED_BOTS: ScriptedBot[] = [alpha, beta, gamma, delta, epsilon];

// ── 自主选择全部游戏 ──────────────────────────────────────────

const GAME_NAMES: Record<GameId, string> = {
  slots: '老虎机', roulette: '欧式轮盘', crash: '大火箭', blackjack: '黑杰克',
  baccarat: '百家乐', sicbo: '骰宝', holdem: '德州扑克', 'video-poker': '视频扑克',
  'dragon-tiger': '龙虎斗', wheel: '幸运大转盘', plinko: '弹珠台', craps: '花旗骰',
  keno: '基诺彩票', 'hi-lo': '高低猜',
};

const GAME_PREFERENCES: Record<string, GameId[]> = {
  alpha: ['slots', 'plinko', 'keno', 'wheel', 'video-poker', 'roulette', 'baccarat', 'sicbo', 'crash', 'hi-lo', 'holdem', 'craps', 'blackjack', 'dragon-tiger'],
  beta: ['dragon-tiger', 'baccarat', 'sicbo', 'craps', 'holdem', 'video-poker', 'hi-lo', 'roulette', 'keno', 'wheel', 'blackjack', 'slots', 'plinko', 'crash'],
  gamma: ['roulette', 'keno', 'wheel', 'plinko', 'slots', 'sicbo', 'baccarat', 'crash', 'holdem', 'video-poker', 'hi-lo', 'craps', 'blackjack', 'dragon-tiger'],
  delta: ['crash', 'baccarat', 'craps', 'blackjack', 'holdem', 'video-poker', 'hi-lo', 'roulette', 'sicbo', 'wheel', 'plinko', 'keno', 'slots', 'dragon-tiger'],
  epsilon: ['blackjack', 'holdem', 'video-poker', 'hi-lo', 'craps', 'baccarat', 'sicbo', 'dragon-tiger', 'roulette', 'slots', 'keno', 'plinko', 'wheel', 'crash'],
};

export interface GameChoice { gameId: GameId; reason: string; }

export function chooseBotGame(bot: ScriptedBot, ctx: BotContext, currentGameId: string): GameChoice {
  const order = GAME_PREFERENCES[bot.id] ?? [...GAME_IDS];
  const block = Math.floor(ctx.roundIndex / 3);
  const losses = trailingLosses(ctx.recentNet);
  const preferenceIndex = (block + (losses >= 3 ? 1 : 0)) % order.length;
  const next = order[preferenceIndex] ?? (bot.gameId as GameId);
  if (next === currentGameId) return { gameId: next, reason: '' };
  const from = GAME_NAMES[currentGameId as GameId] ?? currentGameId;
  const to = GAME_NAMES[next];
  const reason = losses >= 3
    ? `最近连续 ${losses} 局没赢。我不打算只靠加注硬扛，先从「${from}」切到「${to}」，换一种规则重新判断。`
    : `「${from}」我已经连续玩了三局，样本够我复盘这一轮。现在换成「${to}」——这是我的主动选择，不是系统随机分配。`;
  return { gameId: next, reason };
}

export function openOtherGame(bot: ScriptedBot, gameId: GameId, ctx: BotContext): OpenDecision {
  const baseBet = Math.max(ctx.minBetCents, Math.min(coins(10), Math.floor(ctx.balanceCents / 10)));
  const params: Record<string, unknown> = {};
  if (gameId === 'roulette') params.bet = bot.id === 'gamma' ? 'straight:17' : 'red';
  if (gameId === 'dragon-tiger') params.bet = 'dragon';
  if (gameId === 'baccarat') params.bet = 'banker';
  if (gameId === 'sicbo') params.bet = bot.id === 'alpha' ? 'small' : 'big';
  if (gameId === 'plinko') params.risk = bot.id === 'delta' || bot.id === 'beta' ? 'low' : 'medium';
  if (gameId === 'keno') params.picks = [3, 17, 42, 58, 71];
  return { params, betCents: baseBet, reasoning: `${bot.displayName} 选择玩「${GAME_NAMES[gameId]}」。我先用小注熟悉这一轮的局面，再根据规则决定下一步。` };
}

const rankValue = (rank: string): number => rank === 'A' ? 14 : rank === 'K' ? 13 : rank === 'Q' ? 12 : rank === 'J' ? 11 : Number(rank) || 0;

export function actOtherGame(bot: ScriptedBot, gameId: GameId, view: Record<string, unknown>, ctx: BotContext): ActionDecision {
  const oneAction = (type: string, reasoning: string, extra: Record<string, unknown> = {}): ActionDecision => ({ action: { type, ...extra }, reasoning });
  switch (gameId) {
    case 'slots': return oneAction('spin', '这一把就看转轴组合，不存在中途操作；我转。');
    case 'roulette': return oneAction('spin', `我已经押好 ${String(view.bet ?? '号码')}，现在让转盘给答案。`);
    case 'dragon-tiger': return oneAction('deal', `我押了${String(view.bet ?? '龙')}，龙虎没有可靠的短期预测，我只记录样本。`);
    case 'baccarat': return oneAction('deal', `百家乐补牌规则固定；这把押${view.bet === 'banker' ? '庄' : '闲'}，开牌。`);
    case 'sicbo': return oneAction('roll', `三颗骰独立掷出。我押${String(view.betLabel ?? view.bet ?? '大')}，现在掷。`);
    case 'wheel': return oneAction('spin', '倍率转盘结果不可预测。我接受赔率表，开始转。');
    case 'plinko': return oneAction('drop', `我选了${view.risk === 'low' ? '低' : view.risk === 'high' ? '高' : '中'}风险；风险改变波动，不改变期望。放球。`);
    case 'keno': return oneAction('draw', `号码已选：${Array.isArray(view.picks) ? (view.picks as number[]).join('、') : '五个号码'}。现在开奖。`);
    case 'craps': return oneAction('roll', view.point ? `Point 是 ${view.point}。我继续掷，争取先打中 point，而不是先出 7。` : '首掷决定直接赢、直接输还是建立 point；我掷。');
    case 'holdem': {
      const cards = Array.isArray(view.player) ? (view.player as { rank: string }[]) : [];
      const ranks = cards.map((c) => rankValue(c.rank));
      const playable = ranks.length === 2 && (ranks[0] === ranks[1] || Math.max(...ranks) >= 12 || ctx.roundIndex % 3 === 0);
      return playable ? oneAction('call', `我的底牌是 ${cards.map((c) => c.rank).join('、')}。对子或高牌值得看公共牌，我跟注。`) : oneAction('fold', `我的底牌 ${cards.map((c) => c.rank).join('、')} 不够好，这把弃牌，少亏一注。`);
    }
    case 'video-poker': {
      const hand = Array.isArray(view.hand) ? (view.hand as { rank: string }[]) : [];
      const counts = new Map<string, number>();
      for (const c of hand) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
      const hold = hand.flatMap((c, i) => rankValue(c.rank) >= 11 || (counts.get(c.rank) ?? 0) >= 2 ? [i] : []);
      return oneAction('draw', `我保留高牌与对子（位置 ${hold.length ? hold.map((i) => i + 1).join('、') : '无'}），其余换掉。`, { hold });
    }
    case 'hi-lo': {
      const mult = Number(view.multiplier ?? 0.97);
      const guesses = Number(view.guesses ?? 0);
      const p = view.probabilities as { higher?: number; lower?: number } | undefined;
      if (mult >= 1.8 || guesses >= 3) return oneAction('collect', `现在潜在返还 ${mult.toFixed(2)} 倍，我先落袋，不为多猜一把把已有收益赔回去。`);
      const direction = Number(p?.higher ?? 0) >= Number(p?.lower ?? 0) ? 'higher' : 'lower';
      return oneAction(direction, `下一张${direction === 'higher' ? '更高' : '更低'}的概率更大（${(Math.max(Number(p?.higher ?? 0), Number(p?.lower ?? 0)) * 100).toFixed(1)}%），我按概率较高的一边猜。`);
    }
    case 'blackjack': {
      const total = Number(view.playerTotal ?? 0);
      const actions = (view.actions as string[] | undefined) ?? [];
      if (actions.includes('double') && (total === 10 || total === 11)) return oneAction('double', `${total} 点，加倍是合理的进攻机会。`);
      if (total <= 16) return oneAction('hit', `${total} 点还不够，我再要一张。`);
      return oneAction('stand', `${total} 点，我停牌，避免自己爆牌。`);
    }
    case 'crash': return { action: { type: 'cashout', atMs: 3500 }, reasoning: '我选择低倍收手，少贪一点。', waitBeforeMs: 3500 };
    default: return oneAction('spin', `${bot.displayName} 用默认动作继续。`);
  }
}

export function gameName(gameId: string): string { return GAME_NAMES[gameId as GameId] ?? gameId; }
