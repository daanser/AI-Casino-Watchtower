/**
 * 老虎机（3 轴单线）
 *
 * 三个转轴各自独立按权重抽符号，中线三连即中奖；恰好两个樱桃另有小奖。
 * 权重与赔率是配平过的，实测 RTP ≈ 0.93（见 test/games.test.ts 的蒙特卡洛验证）。
 */

import { PlaygroundError } from '@ai-gaming/shared';
import type { GameAction, GameModule, GameStep } from './types';
import { assertKnownAction } from './types';
import type { Rng } from '../rng';

interface SymbolDef {
  id: string;
  label: string;
  weight: number;
  /** 三连时的总返还倍数（含本金） */
  three: number;
}

/** 权重合计 100，方便读也方便算 */
export const SYMBOLS: SymbolDef[] = [
  { id: 'cherry', label: '🍒', weight: 25, three: 8 },
  { id: 'lemon', label: '🍋', weight: 25, three: 12 },
  { id: 'bell', label: '🔔', weight: 18, three: 20 },
  { id: 'star', label: '⭐', weight: 14, three: 32 },
  { id: 'diamond', label: '💎', weight: 11, three: 60 },
  { id: 'seven', label: '7️⃣', weight: 7, three: 150 },
];

const TOTAL_WEIGHT = SYMBOLS.reduce((s, x) => s + x.weight, 0);

/** 恰好两个樱桃（第三个不是樱桃）的总返还倍数 */
const TWO_CHERRY = 2;

const byId = new Map(SYMBOLS.map((s) => [s.id, s]));

function drawSymbol(rng: Rng): SymbolDef {
  let r = rng.int(TOTAL_WEIGHT);
  for (const s of SYMBOLS) {
    if (r < s.weight) return s;
    r -= s.weight;
  }
  return SYMBOLS[SYMBOLS.length - 1] as SymbolDef;
}

export interface SlotsState {
  /** 本局投入的注额（分） */
  stakeCents: number;
  reels: string[];
  revealed: boolean;
  step: number;
}

/** 返回总返还倍数（含本金）。0 表示输。 */
export function slotsMultiplier(reels: string[]): number {
  const [a, b, c] = reels;
  if (a === b && b === c) {
    const def = byId.get(a as string);
    return def ? def.three : 0;
  }
  const cherries = reels.filter((s) => s === 'cherry').length;
  if (cherries === 2) return TWO_CHERRY;
  return 0;
}

export const slots: GameModule<SlotsState> = {
  meta: {
    id: 'slots',
    name: '老虎机',
    description:
      '三个转轴各随机停在一个符号上。中线三连即中奖：🍒×3 返还 8 倍、🍋×3 返还 12 倍、' +
      '🔔×3 返还 20 倍、⭐×3 返还 32 倍、💎×3 返还 60 倍、7️⃣×3 返还 150 倍；' +
      '恰好两个 🍒 返还 2 倍。其余不中。',
    minBetCents: 100,
    maxBetCents: 100000,
    actions: ['spin'],
    pacing: 'instant',
  },

  init({ rng, betCents }) {
    const reels = [drawSymbol(rng).id, drawSymbol(rng).id, drawSymbol(rng).id];
    return {
      state: { stakeCents: betCents, reels, revealed: false, step: 0 },
      events: [{ type: 'reels_loaded', payload: {}, delayMs: 0 }],
      done: false,
    };
  },

  validate(state, action: GameAction) {
    assertKnownAction(slots.meta, action);
    if (state.revealed) {
      throw new PlaygroundError('DUPLICATE_ACTION', '这一局已经转过了');
    }
  },

  act(state): GameStep<SlotsState> {
    const label = (i: number) => byId.get(state.reels[i] as string)?.label ?? state.reels[i];
    return {
      state: { ...state, revealed: true, step: state.step + 1 },
      events: [
        { type: 'reel_stop', payload: { reel: 0, symbol: state.reels[0], label: label(0) }, delayMs: 300 },
        { type: 'reel_stop', payload: { reel: 1, symbol: state.reels[1], label: label(1) }, delayMs: 400 },
        { type: 'reel_stop', payload: { reel: 2, symbol: state.reels[2], label: label(2) }, delayMs: 500 },
        {
          type: 'result',
          payload: { reels: state.reels, multiplier: slotsMultiplier(state.reels) },
          delayMs: 500,
        },
      ],
      done: true,
    };
  },

  /** 转轴没停之前，符号一个都不能漏 */
  publicView(state) {
    if (!state.revealed) return { revealed: false };
    return {
      revealed: true,
      reels: state.reels,
      multiplier: slotsMultiplier(state.reels),
      labels: state.reels.map((id) => byId.get(id)?.label ?? id),
    };
  },

  settle(state) {
    const multiplier = slotsMultiplier(state.reels);
    return {
      payoutCents: Math.round(state.stakeCents * multiplier),
      stakedCents: state.stakeCents,
      breakdown: { reels: state.reels, multiplier, won: multiplier > 0 },
    };
  },
};
