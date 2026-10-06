/**
 * 游戏模块测试
 *
 * 重点是两件事：
 *   1. publicView 在「揭示之前」绝不能泄露任何隐藏信息
 *   2. 蒙特卡洛实测返还率（RTP）必须落在设计值附近
 *
 * 第 2 条是真正有用的：赔率表改一个数字，RTP 就漂了，这个测试会立刻抓到。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../src/rng';
import { roulette } from '../src/games/roulette';
import { slots, slotsMultiplier } from '../src/games/slots';
import { dragonTiger } from '../src/games/dragon-tiger';
import { crash, msForMultiplier, multiplierAt } from '../src/games/crash';
import { blackjack, handValue } from '../src/games/blackjack';
import type { GameModule } from '../src/games/types';

const BET = 100;

/** 用同一套确定性 RNG 跑 n 局，返回实测 RTP（返还 / 投入） */
function measureRtp(game: GameModule<any>, params: Record<string, unknown>, n: number): number {
  let staked = 0;
  let returned = 0;
  for (let i = 0; i < n; i++) {
    const init = game.init({ betCents: BET, rng: makeRng('rtp', 'c', i, 0), params });
    const acted = game.act(init.state, { type: game.meta.actions[0] }, makeRng('rtp', 'c', i, 1));
    const settled = game.settle(acted.state);
    staked += BET;
    returned += settled.payoutCents;
  }
  return returned / staked;
}

const N = 200_000;

// ─────────────────────────────────────────────────────────────
// 隐藏信息
// ─────────────────────────────────────────────────────────────

test('轮盘：揭示前不泄露中奖号码', () => {
  const init = roulette.init({ betCents: BET, rng: makeRng('s', 'c', 1, 0), params: { bet: 'red' } });
  const view = roulette.publicView(init.state) as Record<string, unknown>;
  assert.equal(view.bet, 'red');
  assert.equal('winning' in view, false, '开局局面里出现了中奖号码');
  assert.equal('color' in view, false);

  const acted = roulette.act(init.state, { type: 'spin' }, makeRng('s', 'c', 1, 1));
  assert.equal(typeof (roulette.publicView(acted.state) as any).winning, 'number');
});

test('老虎机：揭示前不泄露转轴符号', () => {
  const init = slots.init({ betCents: BET, rng: makeRng('s', 'c', 1, 0), params: {} });
  const view = slots.publicView(init.state) as Record<string, unknown>;
  assert.equal('reels' in view, false, '开局局面里出现了转轴结果');
  assert.equal(view.revealed, false);
});

test('龙虎斗：揭示前不泄露两张牌', () => {
  const init = dragonTiger.init({ betCents: BET, rng: makeRng('s', 'c', 1, 0), params: { bet: 'dragon' } });
  const view = dragonTiger.publicView(init.state) as Record<string, unknown>;
  assert.equal('dragon' in view, false, '开局局面里出现了龙牌');
  assert.equal('tiger' in view, false);
  assert.equal('winner' in view, false);
});

// ─────────────────────────────────────────────────────────────
// 赔率表
// ─────────────────────────────────────────────────────────────

test('老虎机赔率表：三连与两樱桃的判定正确', () => {
  assert.equal(slotsMultiplier(['seven', 'seven', 'seven']), 150);
  assert.equal(slotsMultiplier(['diamond', 'diamond', 'diamond']), 60);
  assert.equal(slotsMultiplier(['cherry', 'cherry', 'cherry']), 8, '三樱桃应走三连档，不是两樱桃档');
  assert.equal(slotsMultiplier(['cherry', 'cherry', 'lemon']), 2);
  assert.equal(slotsMultiplier(['cherry', 'lemon', 'bell']), 0);
  assert.equal(slotsMultiplier(['seven', 'seven', 'lemon']), 0);
});

test('轮盘赔率：红黑单双大小打单号', () => {
  const cases: Array<[string, number, number]> = [
    ['red', 32, 2],
    ['red', 1, 2],
    ['red', 0, 0],
    ['black', 15, 2],
    ['black', 0, 0],
    ['even', 0, 0],
    ['odd', 17, 2],
    ['low', 18, 2],
    ['high', 19, 2],
    ['dozen1', 12, 3],
    ['dozen2', 13, 3],
    ['dozen3', 36, 3],
    ['straight:17', 17, 36],
    ['straight:17', 18, 0],
    ['straight:0', 0, 36],
  ];
  for (const [bet, winning, expect] of cases) {
    const init = roulette.init({ betCents: BET, rng: makeRng('x', 'c', 1, 0), params: { bet } });
    const s = { ...init.state, winning, revealed: true };
    assert.equal(roulette.settle(s).payoutCents / BET, expect, `${bet} 押 ${winning} 应返 ${expect}`);
  }
});

// ─────────────────────────────────────────────────────────────
// 返还率（RTP）
// ─────────────────────────────────────────────────────────────

test(`老虎机 RTP ≈ 0.93（实测 ${N / 1000}k 局）`, () => {
  const rtp = measureRtp(slots, {}, N);
  assert.ok(Math.abs(rtp - 0.928) < 0.04, `实测 RTP = ${rtp.toFixed(4)}，偏离设计值 0.928 太多`);
});

test(`轮盘押红 RTP ≈ 0.973（实测 ${N / 1000}k 局）`, () => {
  const rtp = measureRtp(roulette, { bet: 'red' }, N);
  // 单零轮盘押 1:1 注：36/37 = 0.97297
  assert.ok(Math.abs(rtp - 36 / 37) < 0.01, `实测 RTP = ${rtp.toFixed(4)}，理论值 ${(36 / 37).toFixed(4)}`);
});

test(`轮盘押单号 RTP ≈ 0.973（实测 ${N / 1000}k 局）`, () => {
  const rtp = measureRtp(roulette, { bet: 'straight:17' }, N);
  assert.ok(Math.abs(rtp - 36 / 37) < 0.02, `实测 RTP = ${rtp.toFixed(4)}`);
});

test(`龙虎斗押龙 RTP ≈ 0.925（实测 ${N / 1000}k 局）`, () => {
  const rtp = measureRtp(dragonTiger, { bet: 'dragon' }, N);
  assert.ok(Math.abs(rtp - 0.9253) < 0.012, `实测 RTP = ${rtp.toFixed(4)}`);
});

test(`龙虎斗和局概率 ≈ 7.47%（实测 ${N / 1000}k 局）`, () => {
  let ties = 0;
  for (let i = 0; i < N; i++) {
    const init = dragonTiger.init({ betCents: BET, rng: makeRng('tie', 'c', i, 0), params: { bet: 'dragon' } });
    if (init.state.dragon.rank === init.state.tiger.rank) ties++;
  }
  const p = ties / N;
  // 8 副牌不放回：13 × (32/416) × (31/415) ≈ 0.0747，不是 1/13 ≈ 0.0769
  assert.ok(Math.abs(p - 0.0747) < 0.003, `实测和局率 = ${p.toFixed(4)}，理论值 0.0747`);
});

test('龙虎斗和局时龙虎注通吃，和注赔 9 倍', () => {
  const tie = dragonTiger.init({ betCents: BET, rng: makeRng('x', 'c', 1, 0), params: { bet: 'dragon' } }).state;
  tie.dragon = { rank: 7, label: '7', suit: '♠' };
  tie.tiger = { rank: 7, label: '7', suit: '♥' };
  assert.equal(dragonTiger.settle(tie).payoutCents, 0, '和局时押龙应通吃');

  const tieBet = { ...tie, bet: 'tie' };
  assert.equal(dragonTiger.settle(tieBet).payoutCents / BET, 9);
});

// ─────────────────────────────────────────────────────────────
// 大火箭
// ─────────────────────────────────────────────────────────────

test('大火箭：揭示前不泄露崩溃点', () => {
  const init = crash.init({ betCents: BET, rng: makeRng('s', 'c', 1, 0), params: {} });
  const view = crash.publicView(init.state) as Record<string, unknown>;
  assert.equal('crashPoint' in view, false, '开局局面里出现了崩溃点');
  assert.equal('multiplier' in view, false);
  assert.equal(typeof view.growthHalfLifeMs, 'number');
});

test('大火箭：乘数与时间互相可逆', () => {
  assert.equal(multiplierAt(0), 1);
  assert.equal(multiplierAt(5000), 2);
  assert.equal(multiplierAt(10000), 4);
  assert.equal(multiplierAt(15000), 8);
  for (const target of [1.2, 1.5, 2, 3, 10]) {
    const back = multiplierAt(msForMultiplier(target));
    assert.ok(Math.abs(back - target) < 0.02, `目标 ${target} 往返后变成 ${back}`);
  }
});

test('大火箭：涨过崩溃点才收手就全输', () => {
  const init = crash.init({ betCents: BET, rng: makeRng('s', 'c', 7, 0), params: {} });
  const cp = init.state.crashPoint;

  // 恰好在崩溃点之前收手 → 赢
  const before = msForMultiplier(Math.max(1, cp - 0.05));
  const win = crash.act(init.state, { type: 'cashout', atMs: before }, makeRng('s', 'c', 7, 1));
  assert.equal(win.state.busted, false);
  assert.ok(crash.settle(win.state).payoutCents > 0);

  // 远远涨过崩溃点才收手 → 全输
  const after = msForMultiplier(cp * 2 + 1);
  const lose = crash.act(init.state, { type: 'cashout', atMs: after }, makeRng('s', 'c', 7, 1));
  assert.equal(lose.state.busted, true);
  assert.equal(crash.settle(lose.state).payoutCents, 0);
});

test('大火箭：任意收手点返还率都是 97%', () => {
  const N = 100_000;
  for (const target of [1.2, 1.5, 2.0, 5.0]) {
    const atMs = msForMultiplier(target);
    let staked = 0;
    let returned = 0;
    for (let i = 0; i < N; i++) {
      const init = crash.init({ betCents: BET, rng: makeRng('crash', 'c', i, 0), params: {} });
      const acted = crash.act(init.state, { type: 'cashout', atMs }, makeRng('crash', 'c', i, 1));
      staked += BET;
      returned += crash.settle(acted.state).payoutCents;
    }
    const rtp = returned / staked;
    assert.ok(
      Math.abs(rtp - 0.97) < 0.025,
      `目标 ${target} 倍时实测 RTP = ${rtp.toFixed(4)}，设计值 0.97`,
    );
  }
});

// ─────────────────────────────────────────────────────────────
// 黑杰克
// ─────────────────────────────────────────────────────────────

/** 造一张牌：rank 0=A, 1=2 … 8=9, 9=10, 10=J, 11=Q, 12=K */
const card = (rank: number, suit = 0, deck = 0) => deck * 52 + suit * 13 + rank;

/** 造一个已经打完的黑杰克局面，用来直接验算结算 */
const bjState = (playerRanks: number[], dealerRanks: number[], doubled = false) => ({
  stakeCents: BET,
  shoe: [],
  drawn: 0,
  player: playerRanks.map((r, i) => card(r, i)),
  dealer: dealerRanks.map((r, i) => card(r, i + 2)),
  revealed: true,
  finished: true,
  doubled,
  step: 1,
});

test('黑杰克：手牌点数，A 自动在 1 和 11 之间切换', () => {
  assert.equal(handValue([card(0), card(9)]).total, 21); // A + 10
  assert.equal(handValue([card(0), card(0)]).total, 12); // A + A = 12 而不是 22
  assert.equal(handValue([card(0), card(0), card(0)]).total, 13);
  assert.equal(handValue([card(0), card(0), card(0), card(0)]).total, 14);
  assert.equal(handValue([card(12), card(11), card(0)]).total, 21); // K Q A
  assert.equal(handValue([card(9), card(10)]).total, 20); // 10 J
  assert.equal(handValue([card(0), card(9), card(9)]).total, 21); // A 10 10
  assert.equal(handValue([card(0), card(0), card(9)]).total, 12); // A A 10
});

test('黑杰克：结算规则', () => {
  const cases: Array<[string, number[], number[], number]> = [
    ['黑杰克赔 3:2', [0, 9], [10, 11], 2.5],
    ['双方黑杰克 → 平', [0, 9], [0, 11], 1],
    ['20 对 19 → 赢', [9, 10], [8, 12], 2],
    ['20 对 20 → 平', [9, 10], [9, 12], 1],
    ['19 对 20 → 输', [8, 12], [9, 10], 0],
    ['庄家爆牌 → 赢', [9, 8], [9, 9, 5], 2],
    ['玩家爆牌 → 输', [9, 9, 5], [9, 8], 0],
    ['庄家黑杰克 → 输', [9, 10], [0, 11], 0],
  ];
  for (const [label, p, d, expect] of cases) {
    assert.equal(blackjack.settle(bjState(p, d)).payoutCents / BET, expect, label);
  }
});

test('黑杰克：揭示前只能看到庄家一张牌', () => {
  let init = blackjack.init({ betCents: BET, rng: makeRng('bj', 'c', 1, 0), params: {} });
  let tries = 0;
  // 玩家一上来就黑杰克的话会直接开牌，换一组种子重来
  while (init.state.finished && tries < 60) {
    tries += 1;
    init = blackjack.init({ betCents: BET, rng: makeRng('bj', 'c', 100 + tries, 0), params: {} });
  }
  assert.equal(init.state.finished, false, '找不到一个未直接结束的开局');

  const view = blackjack.publicView(init.state) as any;
  assert.equal(view.dealer.length, 1, '暗牌没翻开前只能看到一张');
  assert.equal(view.dealerTotal, null);
  assert.equal(view.player.length, 2);
  assert.ok(view.actions.includes('hit'));
  assert.ok(view.actions.includes('double'), '前两张牌时应该允许加倍');
});

test('黑杰克：要牌加牌、停牌交给庄家', () => {
  let init = blackjack.init({ betCents: BET, rng: makeRng('bj', 'c', 1, 0), params: {} });
  let tries = 0;
  while (init.state.finished && tries < 60) {
    tries += 1;
    init = blackjack.init({ betCents: BET, rng: makeRng('bj', 'c', 100 + tries, 0), params: {} });
  }

  const hit = blackjack.act(init.state, { type: 'hit' }, makeRng('bj', 'c', 1, 1));
  assert.equal(hit.state.player.length, 3, '要牌后手上应该有三张');
  assert.equal(hit.state.drawn, init.state.drawn + 1, '牌靴指针应该前进一张');

  // 停牌后庄家必须补到 17 点以上（或者爆牌）
  const stand = blackjack.act(init.state, { type: 'stand' }, makeRng('bj', 'c', 1, 1));
  assert.equal(stand.done, true);
  assert.equal(stand.state.revealed, true, '停牌后应该翻暗牌');
  const dv = handValue(stand.state.dealer).total;
  assert.ok(dv >= 17 || dv > 21, `庄家停牌时点数应 ≥ 17，实际 ${dv}`);
});

test('黑杰克：加倍会追加等额注额并只发一张牌', () => {
  let init = blackjack.init({ betCents: BET, rng: makeRng('bj', 'c', 1, 0), params: {} });
  let tries = 0;
  while (init.state.finished && tries < 60) {
    tries += 1;
    init = blackjack.init({ betCents: BET, rng: makeRng('bj', 'c', 100 + tries, 0), params: {} });
  }

  const doubled = blackjack.act(init.state, { type: 'double' }, makeRng('bj', 'c', 1, 1));
  assert.equal(doubled.stakeDeltaCents, BET, '加倍必须追加等额注额');
  assert.equal(doubled.state.doubled, true);
  assert.equal(doubled.state.player.length, 3, '加倍只发一张牌');
  assert.equal(doubled.done, true);

  // 已经要过牌就不能再加倍了（直接造一个三张牌的局面，避免要牌恰好爆掉）
  const threeCards = {
    ...init.state,
    player: [...init.state.player, init.state.shoe[init.state.drawn] as number],
    drawn: init.state.drawn + 1,
  };
  assert.throws(() => blackjack.validate(threeCards, { type: 'double' }), /两张牌/);
});

test('黑杰克：牌靴是 6 副共 312 张，且洗得开', () => {
  const init = blackjack.init({ betCents: BET, rng: makeRng('bj', 'c', 1, 0), params: {} });
  const shoe = init.state.shoe;
  assert.equal(shoe.length, 312);
  assert.equal(new Set(shoe).size, 312, '牌靴里有重复牌');
  assert.ok(shoe.every((c) => c >= 0 && c < 312), '牌靴里出现了越界的牌');
  assert.notDeepEqual(
    shoe,
    Array.from({ length: 312 }, (_, i) => i),
    '洗牌没生效，牌靴还是原始顺序',
  );
});
