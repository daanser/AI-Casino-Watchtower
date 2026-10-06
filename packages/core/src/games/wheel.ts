/**
 * 幸运大转盘
 *
 * 一个带空扇区的加权转盘。赔率表是配平过的 ——
 * 理论返还率 0.961（Σ权重×倍率 / Σ权重 = 1036/1078）。
 *
 * 注意 0 倍（空扇区）占了过半权重：转盘的"刺激感"来自那 4 个高倍扇区，
 * 但钱是从大片空扇区里赚回来的。这正是这类游戏的本质。
 */

import { PlaygroundError } from '@ai-gaming/shared';
import type { GameAction, GameEventDraft, GameModule, GameStep } from './types';
import { assertKnownAction } from './types';

export interface WheelSegment {
  mult: number;
  weight: number;
}

/** 权重合计 1078，加权返还 = 1036 → RTP ≈ 0.961 */
export const WHEEL_TABLE: WheelSegment[] = [
  { mult: 0, weight: 560 },
  { mult: 1.2, weight: 280 },
  { mult: 1.5, weight: 110 },
  { mult: 2, weight: 60 },
  { mult: 3, weight: 35 },
  { mult: 5, weight: 18 },
  { mult: 10, weight: 10 },
  { mult: 20, weight: 4 },
  { mult: 40, weight: 1 },
];

const TOTAL_WEIGHT = WHEEL_TABLE.reduce((s, x) => s + x.weight, 0);

export interface WheelState {
  stakeCents: number;
  table: WheelSegment[];
  /** 命中的是哪一段（下标） */
  landedIndex: number;
  multiplier: number;
  revealed: boolean;
  step: number;
}

export const wheel: GameModule<WheelState> = {
  meta: {
    id: 'wheel',
    name: '幸运大转盘',
    description:
      '转盘上分布着不同倍率的扇区：0 倍（空）、1.2×、1.5×、2×、3×、5×、10×、20×、40×。' +
      '按权重随机停在某一段，中奖按该段倍率返还（含本金）。' +
      '理论返还率 96.1%。动作固定是 spin，无需押注位。',
    minBetCents: 100,
    maxBetCents: 100000,
    actions: ['spin'],
    pacing: 'instant',
  },

  init({ rng, betCents }) {
    let r = rng.int(TOTAL_WEIGHT);
    let landedIndex = 0;
    for (let i = 0; i < WHEEL_TABLE.length; i += 1) {
      const w = (WHEEL_TABLE[i] as WheelSegment).weight;
      if (r < w) {
        landedIndex = i;
        break;
      }
      r -= w;
    }
    const multiplier = (WHEEL_TABLE[landedIndex] as WheelSegment).mult;

    return {
      state: {
        stakeCents: betCents,
        table: WHEEL_TABLE,
        landedIndex,
        multiplier,
        revealed: false,
        step: 0,
      },
      events: [{ type: 'wheel_ready', payload: { table: WHEEL_TABLE }, delayMs: 0 }],
      done: false,
    };
  },

  validate(state, action: GameAction) {
    assertKnownAction(wheel.meta, action);
    if (state.revealed) {
      throw new PlaygroundError('DUPLICATE_ACTION', '这一把已经转过了');
    }
  },

  act(state): GameStep<WheelState> {
    const events: GameEventDraft[] = [
      { type: 'wheel_spin', payload: {}, delayMs: 600 },
      {
        type: 'wheel_stop',
        payload: { landedIndex: state.landedIndex, multiplier: state.multiplier },
        delayMs: 1400,
      },
    ];
    return {
      state: { ...state, revealed: true, step: state.step + 1 },
      events,
      done: true,
    };
  },

  /** 停之前不能漏出会停在哪一段 */
  publicView(state) {
    if (!state.revealed) return { revealed: false, table: state.table };
    return {
      revealed: true,
      table: state.table,
      landedIndex: state.landedIndex,
      multiplier: state.multiplier,
    };
  },

  settle(state) {
    return {
      payoutCents: Math.round(state.stakeCents * state.multiplier),
      stakedCents: state.stakeCents,
      breakdown: { multiplier: state.multiplier, landedIndex: state.landedIndex },
    };
  },
};
