/** 9 个新游戏：规则、隐藏信息、结算与设计返还率。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../src/rng';
import { createRegistry } from '../src/games';
import type { GameModule } from '../src/games/types';
import { baccarat, baccaratMultiplier, baccaratTotal } from '../src/games/baccarat';
import { sicbo, sicboMultiplier } from '../src/games/sicbo';
import { wheel, WHEEL_TABLE } from '../src/games/wheel';
import { plinko, PLINKO_PAYOUTS, PLINKO_WEIGHTS, plinkoRtp } from '../src/games/plinko';
import { keno, KENO_PAYOUT, KENO_HIT_PROBABILITY } from '../src/games/keno';
import { craps } from '../src/games/craps';
import { holdem } from '../src/games/holdem';
import { videoPoker } from '../src/games/video-poker';
import { hiLo } from '../src/games/hi-lo';
import { CATEGORY, evaluate5, evaluateBest, compareHands, videoPokerMultiplier } from '../src/games/poker';

const BET = 100;
const ids = [
  'slots', 'roulette', 'crash', 'blackjack', 'baccarat', 'sicbo', 'holdem',
  'video-poker', 'dragon-tiger', 'wheel', 'plinko', 'craps', 'keno', 'hi-lo',
];

function playOne(game: GameModule<any>, params: Record<string, unknown>, action: Record<string, unknown>, nonce: number) {
  const init = game.init({ betCents: BET, rng: makeRng('new-games', 'test', nonce, 0), params });
  const before = game.publicView(init.state);
  game.validate(init.state, action as { type: string });
  const acted = game.act(init.state, action as { type: string }, makeRng('new-games', 'test', nonce, 1));
  const after = game.publicView(acted.state);
  const settled = acted.done ? game.settle(acted.state) : null;
  return { init, before, acted, after, settled };
}

function measure(game: GameModule<any>, params: Record<string, unknown>, policy: (view: Record<string, unknown>, i: number) => Record<string, unknown>, n: number): number {
  let wagered = 0;
  let returned = 0;
  for (let i = 0; i < n; i += 1) {
    const init = game.init({ betCents: BET, rng: makeRng('new-rtp', game.meta.id, i, 0), params });
    let state = init.state;
    let done = init.done;
    let step = 1;
    let guard = 0;
    while (!done && guard < 1000) {
      const action = policy(game.publicView(state), i + guard);
      game.validate(state, action as { type: string });
      const next = game.act(state, action as { type: string }, makeRng('new-rtp', game.meta.id, i, step));
      state = next.state;
      done = next.done;
      step += 1;
      guard += 1;
    }
    assert.equal(done, true, `${game.meta.id} 第 ${i} 局超过 1000 步未结束`);
    wagered += BET;
    returned += game.settle(state).payoutCents;
  }
  return returned / wagered;
}

test('游戏注册表已包含完整 14 款游戏', () => {
  const registered = createRegistry().list().map((g) => g.meta.id).sort();
  assert.deepEqual(registered, [...ids].sort());
});

// ── 扑克牌型评估器 ───────────────────────────────────────────

test('牌型识别：皇家同花顺、轮子顺、四条与葫芦', () => {
  // code = suit*13 + rank，黑桃同花
  const royal = [9, 10, 11, 12, 0].map((r) => r);
  assert.equal(evaluate5(royal).category, CATEGORY.ROYAL_FLUSH);
  const wheel = [0, 1, 15, 29, 43];
  assert.equal(evaluate5(wheel).category, CATEGORY.STRAIGHT);
  assert.deepEqual(evaluate5(wheel).tiebreak, [5]);
  assert.equal(evaluate5([0, 13, 26, 39, 8]).category, CATEGORY.FOUR_OF_A_KIND);
  assert.equal(evaluate5([0, 13, 26, 8, 21]).category, CATEGORY.FULL_HOUSE);
});

test('牌型比较：A 高于 K，同花顺高于四条，7 张牌挑最佳 5 张', () => {
  const aceHigh = evaluate5([0, 14, 28, 42, 12]);
  const kingHigh = evaluate5([12, 14, 28, 42, 10]);
  assert.ok(compareHands(aceHigh, kingHigh) > 0);

  const straightFlush = evaluate5([8, 9, 10, 11, 12]);
  const quads = evaluate5([0, 13, 26, 39, 8]);
  assert.ok(compareHands(straightFlush, quads) > 0);

  const best = evaluateBest([0, 13, 26, 39, 8, 9, 10]);
  assert.equal(best.category, CATEGORY.FOUR_OF_A_KIND);
});

test('视频扑克赔率：J 对及以上才赔一对', () => {
  assert.deepEqual(videoPokerMultiplier([10, 23, 2, 29, 44]), { multiplier: 1, label: '一对 J 或更好' });
  assert.equal(videoPokerMultiplier([1, 14, 3, 30, 44]).multiplier, 0); // 一对 2
  assert.equal(videoPokerMultiplier([9, 10, 11, 12, 0]).multiplier, 250); // 同花 A 高顺
});

// ── 单局公开信息与结算 ────────────────────────────────────────

test('百家乐：开局只露押注位，牌与点数等结算后才显示', () => {
  const r = playOne(baccarat, { bet: 'banker' }, { type: 'deal' }, 1);
  assert.equal(r.before.bet, 'banker');
  assert.equal(r.before.revealed, false);
  assert.equal('player' in r.before, false);
  assert.equal('banker' in r.before, false);
  assert.equal(r.after.revealed, true);
  assert.equal((r.after.player as unknown[]).length >= 2, true);
  assert.equal(r.settled?.stakedCents, BET);
});

test('百家乐补牌与倍率规则合法', () => {
  assert.equal(baccaratTotal([0, 9]), 1); // A + 10
  assert.equal(baccaratMultiplier('player', 8, 7), 2);
  assert.equal(baccaratMultiplier('banker', 8, 7), 0);
  assert.equal(baccaratMultiplier('banker', 7, 8), 1.95);
  assert.equal(baccaratMultiplier('player', 7, 8), 0);
  assert.equal(baccaratMultiplier('tie', 5, 5), 9);
  assert.equal(baccaratMultiplier('banker', 5, 5), 1, '和局退回原注');
});

test('骰宝：押注位解析、三同号吃外围注、单骰按个数赔', () => {
  assert.equal(sicboMultiplier('big', [3, 4, 5]), 2);
  assert.equal(sicboMultiplier('small', [2, 3, 4]), 2);
  assert.equal(sicboMultiplier('big', [4, 4, 4]), 0);
  assert.equal(sicboMultiplier('even', [2, 2, 2]), 0);
  assert.equal(sicboMultiplier('any-triple', [6, 6, 6]), 31);
  assert.equal(sicboMultiplier('triple:3', [3, 3, 3]), 181);
  assert.equal(sicboMultiplier('single:4', [4, 4, 1]), 3);
  assert.equal(sicboMultiplier('sum:10', [2, 3, 5]), 7);
  const r = playOne(sicbo, { bet: 'small' }, { type: 'roll' }, 2);
  assert.equal('dice' in r.before, false);
  assert.equal((r.after.dice as number[]).length, 3);
});

test('幸运大转盘：落点揭晓前不泄漏中奖段，赔率表设计 RTP ≈ 96.1%', () => {
  const r = playOne(wheel, {}, { type: 'spin' }, 3);
  assert.equal('landedIndex' in r.before, false);
  assert.equal('multiplier' in r.before, false);
  assert.equal(typeof r.after.landedIndex, 'number');
  const weight = WHEEL_TABLE.reduce((s, x) => s + x.weight, 0);
  const returned = WHEEL_TABLE.reduce((s, x) => s + x.weight * x.mult, 0);
  assert.ok(Math.abs(returned / weight - 0.961) < 0.001);
});

test('弹珠台：落点与轨迹在结算前保密，三档 RTP 都接近 96%', () => {
  const r = playOne(plinko, { risk: 'high' }, { type: 'drop' }, 4);
  assert.equal('slot' in r.before, false);
  assert.equal('path' in r.before, false);
  assert.equal('multiplier' in r.before, false);
  assert.equal((r.after.path as number[]).length, 8);
  assert.equal((r.after.slot as number), (r.after.path as number[]).reduce((a, b) => a + b, 0));
  assert.equal(PLINKO_WEIGHTS.reduce((a, b) => a + b, 0), 256);
  for (const risk of ['low', 'medium', 'high'] as const) {
    assert.ok(plinkoRtp(risk) > 0.95 && plinkoRtp(risk) < 0.97, `${risk} RTP=${plinkoRtp(risk)}`);
    assert.equal(PLINKO_PAYOUTS[risk].length, 9);
  }
});

test('基诺：开奖前隐藏开奖号码；赔率表与超几何概率相符', () => {
  const r = playOne(keno, { picks: [3, 17, 42, 58, 71] }, { type: 'draw' }, 5);
  assert.equal('drawn' in r.before, false);
  assert.equal('hits' in r.before, false);
  assert.equal((r.after.drawn as number[]).length, 20);
  assert.equal(r.settled?.stakedCents, BET);
  assert.equal(KENO_HIT_PROBABILITY.length, 6);
  assert.ok(Math.abs(KENO_HIT_PROBABILITY.reduce((a, b) => a + b, 0) - 1) < 0.002);
  const rtp = KENO_HIT_PROBABILITY.reduce((s, p, i) => s + p * (KENO_PAYOUT[i] ?? 0), 0);
  assert.ok(rtp > 0.96 && rtp < 0.98, `理论 RTP=${rtp}`);
});

test('花旗骰：未结局时可见 point / 已掷骰，不泄露未来骰子', () => {
  const init = craps.init({ betCents: BET, rng: makeRng('craps', 't', 6, 0), params: {} });
  assert.equal(craps.publicView(init.state).phase, 'come_out');
  assert.equal('nextRoll' in craps.publicView(init.state), false);
  let state = init.state;
  let done = false;
  for (let step = 1; step <= 100 && !done; step += 1) {
    craps.validate(state, { type: 'roll' });
    const next = craps.act(state, { type: 'roll' }, makeRng('craps', 't', 6, step));
    state = next.state;
    done = next.done;
  }
  assert.equal(done, true);
  assert.equal(state.revealed, true);
  assert.equal(craps.settle(state).stakedCents, BET);
});

test('德州扑克：底牌可见，庄家底牌与公共牌结算前隐藏', () => {
  const r = playOne(holdem, {}, { type: 'call' }, 7);
  assert.equal((r.before.player as unknown[]).length, 2);
  assert.equal('dealer' in r.before, false);
  assert.equal((r.before.board as unknown[]).length, 0);
  assert.equal((r.after.dealer as unknown[]).length, 2);
  assert.equal((r.after.board as unknown[]).length, 5);
  assert.ok([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].includes((r.after.playerHand as { category: number }).category));
});

test('德州扑克：fold 立即结束并输掉注额', () => {
  const r = playOne(holdem, {}, { type: 'fold' }, 8);
  assert.equal(r.acted.done, true);
  assert.equal(r.settled?.payoutCents, 0);
});

test('视频扑克：初始牌可见，换牌后结算，hold 不能重复位置', () => {
  const init = videoPoker.init({ betCents: BET, rng: makeRng('vp', 't', 9, 0), params: {} });
  assert.equal((videoPoker.publicView(init.state).hand as unknown[]).length, 5);
  assert.throws(() => videoPoker.validate(init.state, { type: 'draw', hold: [0, 0] }), /不能重复/);
  const step = videoPoker.act(init.state, { type: 'draw', hold: [0, 1, 2, 3, 4] }, makeRng('vp', 't', 9, 1));
  assert.equal(step.done, true);
  assert.equal(step.state.hand.length, 5);
  assert.equal(step.state.position, 5);
  assert.equal(step.state.multiplier, videoPokerMultiplier(step.state.hand).multiplier);
});

test('高低猜：初始倍率已扣 house edge，猜错清零，collect 结束结算', () => {
  const init = hiLo.init({ betCents: BET, rng: makeRng('hilo', 't', 10, 0), params: {} });
  assert.equal((hiLo.publicView(init.state).current as { code: number }).code, init.state.current);
  assert.equal('nextCard' in hiLo.publicView(init.state), false);
  assert.equal(init.state.multiplier, 0.97);

  const collect = hiLo.act(init.state, { type: 'collect' }, makeRng('hilo', 't', 10, 1));
  assert.equal(collect.done, true);
  assert.equal(hiLo.settle(collect.state).payoutCents, 97);

  const guess = init.state.current % 13 === 0 ? 'lower' : 'higher';
  const next = hiLo.act(init.state, { type: guess }, makeRng('hilo', 't', 10, 1));
  if (!next.state.won) assert.equal(hiLo.settle(next.state).payoutCents, 0);
});

// ── 蒙特卡洛返还率 ────────────────────────────────────────────

test('百家乐押庄 RTP 落在标准约 98.9% 附近', () => {
  const n = 100_000;
  let returned = 0;
  for (let i = 0; i < n; i += 1) {
    const init = baccarat.init({ betCents: BET, rng: makeRng('baccarat-rtp', 'c', i, 0), params: { bet: 'banker' } });
    const acted = baccarat.act(init.state, { type: 'deal' }, makeRng('baccarat-rtp', 'c', i, 1));
    returned += baccarat.settle(acted.state).payoutCents;
  }
  const rtp = returned / (BET * n);
  assert.ok(rtp > 0.975 && rtp < 1.005, `实测 baccarat RTP=${rtp}`);
});

test('骰宝大注 RTP 实测约 97.2%', () => {
  const rtp = measure(sicbo, { bet: 'big' }, () => ({ type: 'roll' }), 80_000);
  assert.ok(rtp > 0.94 && rtp < 1.005, `实测 sicbo RTP=${rtp}`);
});

test('转盘 RTP 实测接近赔率表理论值', () => {
  const rtp = measure(wheel, {}, () => ({ type: 'spin' }), 120_000);
  assert.ok(rtp > 0.91 && rtp < 1.02, `实测 wheel RTP=${rtp}`);
});

test('Plinko 三档风险 RTP 均约 96%', () => {
  for (const risk of ['low', 'medium', 'high'] as const) {
    const rtp = measure(plinko, { risk }, () => ({ type: 'drop' }), 80_000);
    assert.ok(rtp > 0.91 && rtp < 1.01, `${risk} RTP=${rtp}`);
  }
});

test('Keno 的蒙特卡洛 RTP 与超几何赔率表大致一致', () => {
  const rtp = measure(keno, { picks: [3, 17, 42, 58, 71] }, () => ({ type: 'draw' }), 100_000);
  assert.ok(rtp > 0.75 && rtp < 1.2, `实测 keno RTP=${rtp}`);
});

test('花旗骰 Pass Line RTP 实测接近 98.6%', () => {
  const rtp = measure(craps, {}, () => ({ type: 'roll' }), 30_000);
  assert.ok(rtp > 0.95 && rtp < 1.02, `实测 craps RTP=${rtp}`);
});

test('视频扑克全保留策略的实测返还率稳定且低于本金', () => {
  const rtp = measure(videoPoker, {}, () => ({ type: 'draw', hold: [0, 1, 2, 3, 4] }), 60_000);
  assert.ok(rtp > 0.25 && rtp < 0.75, `实测 hold-all RTP=${rtp}`);
});

test('高低猜收手 RTP 为 97%，猜对方向赔率经过 house edge 调整', () => {
  const rtp = measure(hiLo, {}, () => ({ type: 'collect' }), 1000);
  assert.ok(Math.abs(rtp - 0.97) < 0.0001, `collect RTP=${rtp}`);

  let checked = false;
  for (let i = 0; i < 100 && !checked; i += 1) {
    const init = hiLo.init({ betCents: BET, rng: makeRng('hilo-prob', 'c', i, 0), params: {} });
    const view = hiLo.publicView(init.state) as { probabilities: { higher: number; lower: number } };
    const dir = view.probabilities.higher >= view.probabilities.lower ? 'higher' : 'lower';
    const step = hiLo.act(init.state, { type: dir }, makeRng('hilo-prob', 'c', i, 1));
    if (step.state.won) {
      assert.ok(step.state.multiplier > 0.97);
      checked = true;
    }
  }
  assert.equal(checked, true);
});
