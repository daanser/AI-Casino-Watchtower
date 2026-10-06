/**
 * 弹珠台（Plinko）
 *
 * 小球从顶部下落 8 层，每层各 50% 概率往左或往右。
 * 所以落在第 k 个槽的概率就是二项分布 C(8,k)/256 —— 中间槽最常见，两端最罕见。
 *
 * 三档风险只是换了一组赔率，**返还率刻意保持一致**（都约 0.96）：
 *   低风险：赔率平缓、波动小
 *   高风险：两端给到 25 倍，但中间槽会亏掉 80%
 * 「风险」在这里的含义是方差，不是期望。
 */

import { PlaygroundError } from '@ai-gaming/shared';
import type { GameAction, GameEventDraft, GameModule, GameStep } from './types';
import { assertKnownAction } from './types';
import type { Rng } from '../rng';

export const ROWS = 8;
export const SLOTS = ROWS + 1; // 9 个落点

export type PlinkoRisk = 'low' | 'medium' | 'high';

/** 各落点的总返还倍数（含本金），按风险档位 */
export const PLINKO_PAYOUTS: Record<PlinkoRisk, number[]> = {
  // 加权返还 245.8/256 ≈ 0.960
  low: [5.9, 2.2, 1.1, 0.9, 0.52, 0.9, 1.1, 2.2, 5.9],
  // 加权返还 246.0/256 ≈ 0.961
  medium: [15, 3, 1.3, 0.6, 0.4, 0.6, 1.3, 3, 15],
  // 加权返还 245.6/256 ≈ 0.959
  high: [25, 4, 1.3, 0.4, 0.2, 0.4, 1.3, 4, 25],
};

const RISKS: PlinkoRisk[] = ['low', 'medium', 'high'];

function parseRisk(raw: unknown): PlinkoRisk {
  const r = String(raw ?? 'medium') as PlinkoRisk;
  if (!RISKS.includes(r)) {
    throw new PlaygroundError(
      'INVALID_ACTION',
      `风险档位只能是 ${RISKS.join(' / ')}，收到 "${String(raw)}"`,
    );
  }
  return r;
}

/** 第 k 个落点的概率 × 256（即组合数 C(8,k)） */
export const PLINKO_WEIGHTS = [1, 8, 28, 56, 70, 56, 28, 8, 1];

export interface PlinkoState {
  stakeCents: number;
  risk: PlinkoRisk;
  /** 每一层往左(0)还是往右(1) */
  path: number[];
  /** 落点下标 0..8 */
  slot: number;
  multiplier: number;
  revealed: boolean;
  step: number;
}

export const plinko: GameModule<PlinkoState> = {
  meta: {
    id: 'plinko',
    name: '弹珠台',
    description:
      '小球从顶部下落 8 层，每层各有 50% 概率往左或往右，最后落进 9 个槽之一。' +
      '落在中间槽的概率最大（70/256），两端最小（1/256）。' +
      '风险档位在 params 里传：low / medium / high（默认 medium）。' +
      '低风险两端 5.9 倍、中间 0.5 倍；高风险两端 25 倍、中间 0.2 倍。' +
      '三档返还率都是 96% 左右 —— 风险改变的是波动，不是期望。动作固定是 drop。',
    minBetCents: 100,
    maxBetCents: 100000,
    actions: ['drop'],
    pacing: 'instant',
  },

  init({ rng, params, betCents }) {
    const risk = parseRisk(params.risk);
    const path: number[] = [];
    for (let i = 0; i < ROWS; i += 1) path.push(rng.bool() ? 1 : 0);
    const slot = path.reduce((a, b) => a + b, 0);
    const multiplier = (PLINKO_PAYOUTS[risk] as number[])[slot] as number;

    return {
      state: { stakeCents: betCents, risk, path, slot, multiplier, revealed: false, step: 0 },
      events: [{ type: 'plinko_ready', payload: { risk }, delayMs: 0 }],
      done: false,
    };
  },

  validate(state, action: GameAction) {
    assertKnownAction(plinko.meta, action);
    if (state.revealed) {
      throw new PlaygroundError('DUPLICATE_ACTION', '这一颗已经落下了');
    }
  },

  act(state): GameStep<PlinkoState> {
    const events: GameEventDraft[] = [{ type: 'plinko_drop', payload: {}, delayMs: 200 }];
    // 逐层落下，让前端能画出轨迹
    for (let i = 0; i < state.path.length; i += 1) {
      events.push({
        type: 'plinko_bounce',
        payload: { row: i, dir: state.path[i] === 1 ? 'right' : 'left' },
        delayMs: 220,
      });
    }
    events.push({
      type: 'result',
      payload: { slot: state.slot, multiplier: state.multiplier, risk: state.risk },
      delayMs: 500,
    });

    return {
      state: { ...state, revealed: true, step: state.step + 1 },
      events,
      done: true,
    };
  },

  /** 落点揭晓前不能泄露轨迹 */
  publicView(state) {
    if (!state.revealed) {
      return { revealed: false, risk: state.risk, payouts: PLINKO_PAYOUTS[state.risk] };
    }
    return {
      revealed: true,
      risk: state.risk,
      path: state.path,
      slot: state.slot,
      multiplier: state.multiplier,
      payouts: PLINKO_PAYOUTS[state.risk],
    };
  },

  settle(state) {
    return {
      payoutCents: Math.round(state.stakeCents * state.multiplier),
      stakedCents: state.stakeCents,
      breakdown: { risk: state.risk, slot: state.slot, multiplier: state.multiplier },
    };
  },
};

/** 给测试用：理论返还率 */
export function plinkoRtp(risk: PlinkoRisk): number {
  const payouts = PLINKO_PAYOUTS[risk];
  let num = 0;
  for (let i = 0; i < SLOTS; i += 1) {
    num += (PLINKO_WEIGHTS[i] as number) * (payouts[i] as number);
  }
  return num / 256;
}

/** 给 runner 用：随机挑一档风险 */
export function randomRisk(rng: Rng): PlinkoRisk {
  return rng.pick(RISKS);
}
