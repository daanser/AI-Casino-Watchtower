/**
 * 实测三款「技巧型」游戏的返还率。
 *
 * 黑杰克 / 视频扑克 / 德州扑克的返还率取决于你怎么打，没法写成一个固定数字，
 * 所以这里用几个明确的固定策略各跑 12 万局，把结果打出来。README 里的数字就来自这里。
 *
 * 运行： npm run measure:skill
 */

import { makeRng } from '../packages/core/src/rng';
import { blackjack } from '../packages/core/src/games/blackjack';
import { holdem } from '../packages/core/src/games/holdem';
import { videoPoker } from '../packages/core/src/games/video-poker';
import type { GameModule } from '../packages/core/src/games/types';

const BET = 100;
const ROUNDS = 120_000;

type View = Record<string, unknown>;
type Action = { type: string; [k: string]: unknown };
type Policy = (view: View) => Action;

/** 跑 n 局，返回「总派彩 / 总下注」。payout 已包含本金，所以公平博弈是 1.0。 */
function measure(game: GameModule<any>, params: View, policy: Policy, n = ROUNDS): number {
  let wagered = 0;
  let returned = 0;
  for (let i = 0; i < n; i += 1) {
    const init = game.init({ betCents: BET, rng: makeRng('rtp', game.meta.id, i, 0), params });
    let state = init.state;
    let done = init.done;
    let step = 1;
    let guard = 0;
    while (!done && guard < 1000) {
      const action = policy(game.publicView(state));
      game.validate(state, action as { type: string });
      const next = game.act(state, action as { type: string }, makeRng('rtp', game.meta.id, i, step));
      state = next.state;
      done = next.done;
      step += 1;
      guard += 1;
    }
    if (!done) throw new Error(`${game.meta.id} 第 ${i} 局超过 1000 步仍未结束`);
    wagered += BET;
    returned += game.settle(state).payoutCents;
  }
  return returned / wagered;
}

/** 牌面 → 点数（A 按 11 算，软牌判断另算） */
const cardValue = (rank: string): number =>
  rank === 'A' ? 11 : rank === 'K' || rank === 'Q' || rank === 'J' ? 10 : Number(rank);

// ── 黑杰克：简化版基本策略 ───────────────────────────────────
const blackjackPolicy: Policy = (v) => {
  const total = Number(v.playerTotal ?? 0);
  const actions = (v.actions as string[] | undefined) ?? [];
  const dealer = (v.dealer as { rank: string }[] | undefined) ?? [];
  const up = dealer[0] ? cardValue(dealer[0].rank) : 10;
  const soft = Boolean(v.playerSoft);

  const canDouble = actions.includes('double');
  if (canDouble && total === 11) return { type: 'double' };
  if (canDouble && total === 10 && up <= 9) return { type: 'double' };
  if (canDouble && soft && total >= 13 && total <= 17 && up >= 4 && up <= 6) return { type: 'double' };

  if (soft) {
    if (total >= 19) return { type: 'stand' };
    if (total === 18) return up >= 9 ? { type: 'hit' } : { type: 'stand' };
    return { type: 'hit' };
  }
  if (total >= 17) return { type: 'stand' };
  if (total >= 13 && up <= 6) return { type: 'stand' };
  if (total === 12 && up >= 4 && up <= 6) return { type: 'stand' };
  return { type: 'hit' };
};

// ── 德州扑克：有对子或两张高牌就跟注，否则弃牌 ────────────────
const holdemTight: Policy = (v) => {
  const cards = (v.player as { rank: string }[] | undefined) ?? [];
  if (cards.length !== 2) return { type: 'fold' };
  const [a, b] = [cards[0]!.rank, cards[1]!.rank];
  if (a === b) return { type: 'call' };
  return Math.max(cardValue(a), cardValue(b)) >= 12 ? { type: 'call' } : { type: 'fold' };
};

// ── 视频扑克：保留对子与 J 以上高牌 ──────────────────────────
const videoPokerHoldPairs: Policy = (v) => {
  const hand = (v.hand as { rank: string }[] | undefined) ?? [];
  const counts = new Map<string, number>();
  for (const c of hand) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
  const hold: number[] = [];
  hand.forEach((c, i) => {
    if (cardValue(c.rank) >= 11 || (counts.get(c.rank) ?? 0) >= 2) hold.push(i);
  });
  return { type: 'draw', hold };
};

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

console.log('');
console.log(`  技巧型游戏返还率实测（各 ${ROUNDS.toLocaleString('zh-CN')} 局，注额 ${BET} 分）`);
console.log('  ' + '─'.repeat(62));
console.log(`  黑杰克    简化基本策略                ${pct(measure(blackjack, {}, blackjackPolicy))}`);
console.log(`  德州扑克  对子 / 高牌才跟注            ${pct(measure(holdem, {}, holdemTight))}`);
console.log(`  德州扑克  每局都跟注（无脑跟）          ${pct(measure(holdem, {}, () => ({ type: 'call' })))}`);
console.log(`  视频扑克  保留对子与 J 以上高牌         ${pct(measure(videoPoker, {}, videoPokerHoldPairs))}`);
console.log(`  视频扑克  五张全保留（不换牌）          ${pct(measure(videoPoker, {}, () => ({ type: 'draw', hold: [0, 1, 2, 3, 4] })))}`);
console.log('  ' + '─'.repeat(62));
console.log('  注：1.00 = 打平（拿回本金）。低于 1 就是庄家优势。');
console.log('      德州扑克单挑庄家目前没有抽水，跟注是公平对赌，弃牌才会必然亏损。');
console.log('');
