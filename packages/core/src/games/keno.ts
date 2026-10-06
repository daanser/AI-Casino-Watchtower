/**
 * 基诺彩票（选 5 中 M）
 *
 * 从 1-80 里选 5 个号，开奖开 20 个号，按命中个数赔。
 * 命中数服从超几何分布，赔率表配平后理论返还率约 0.969。
 */

import { PlaygroundError } from '@ai-gaming/shared';
import type { GameAction, GameEventDraft, GameModule, GameStep } from './types';
import { assertKnownAction } from './types';
import type { Rng } from '../rng';

export const POOL_SIZE = 80;
export const DRAWN_COUNT = 20;
export const PICK_COUNT = 5;

/**
 * 命中数 → 总返还倍数（含本金）。
 * 理论返还率 ≈ 0.969（0.2705×1 + 0.0831×2 + 0.0121×20 + 0.000645×450）
 */
export const KENO_PAYOUT: Record<number, number> = {
  0: 0,
  1: 0,
  2: 1,
  3: 2,
  4: 20,
  5: 450,
};

/** 命中数的理论概率（超几何分布 C(5,k)·C(75,20-k)/C(80,20)），测试与文档用 */
export const KENO_HIT_PROBABILITY = [0.227184, 0.405686, 0.270457, 0.083935, 0.012092, 0.000645];

export interface KenoState {
  stakeCents: number;
  picks: number[];
  drawn: number[];
  hits: number[];
  multiplier: number;
  revealed: boolean;
  step: number;
}

function parsePicks(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length !== PICK_COUNT) {
    throw new PlaygroundError(
      'INVALID_ACTION',
      `picks 必须是长度为 ${PICK_COUNT} 的数组，例如 params={"picks":[3,17,42,58,71]}`,
    );
  }
  const picks = raw.map((x) => Number(x));
  for (const p of picks) {
    if (!Number.isInteger(p) || p < 1 || p > POOL_SIZE) {
      throw new PlaygroundError('INVALID_ACTION', `号码必须在 1~${POOL_SIZE} 之间，收到 ${p}`);
    }
  }
  if (new Set(picks).size !== picks.length) {
    throw new PlaygroundError('INVALID_ACTION', '选的号码不能重复');
  }
  return [...picks].sort((a, b) => a - b);
}

export const keno: GameModule<KenoState> = {
  meta: {
    id: 'keno',
    name: '基诺彩票',
    description:
      `从 1~${POOL_SIZE} 里选 ${PICK_COUNT} 个号，开奖开出 ${DRAWN_COUNT} 个号，按命中个数赔：` +
      '中 2 个返 1 倍（回本）、中 3 个返 2 倍、中 4 个返 20 倍、中 5 个返 450 倍；中 0-1 个不赔。' +
      '理论返还率约 96.9%。' +
      '号码在 params 里传，例如 params={"picks":[3,17,42,58,71]}；动作固定是 draw。',
    minBetCents: 100,
    maxBetCents: 100000,
    actions: ['draw'],
    pacing: 'instant',
  },

  init({ rng, params, betCents }) {
    const picks = parsePicks(params.picks);

    // 开奖：从 1..80 里不放回地抽 20 个
    const pool = Array.from({ length: POOL_SIZE }, (_, i) => i + 1);
    const drawn = rng.shuffle(pool).slice(0, DRAWN_COUNT).sort((a, b) => a - b);

    const drawnSet = new Set(drawn);
    const hits = picks.filter((p) => drawnSet.has(p));
    const multiplier = KENO_PAYOUT[hits.length] ?? 0;

    return {
      state: { stakeCents: betCents, picks, drawn, hits, multiplier, revealed: false, step: 0 },
      events: [{ type: 'keno_picked', payload: { picks }, delayMs: 0 }],
      done: false,
    };
  },

  validate(state, action: GameAction) {
    assertKnownAction(keno.meta, action);
    if (state.revealed) {
      throw new PlaygroundError('DUPLICATE_ACTION', '这一期已经开过奖了');
    }
  },

  act(state): GameStep<KenoState> {
    const events: GameEventDraft[] = [];
    // 分 4 批开号，让前端有节奏地一个个点亮
    for (let i = 0; i < state.drawn.length; i += 5) {
      events.push({
        type: 'keno_batch',
        payload: { numbers: state.drawn.slice(i, i + 5), from: i },
        delayMs: 420,
      });
    }
    events.push({
      type: 'result',
      payload: { hits: state.hits, hitCount: state.hits.length, multiplier: state.multiplier },
      delayMs: 600,
    });

    return {
      state: { ...state, revealed: true, step: state.step + 1 },
      events,
      done: true,
    };
  },

  /** 开奖前只能看到自己选的号 */
  publicView(state) {
    if (!state.revealed) return { picks: state.picks, revealed: false };
    return {
      picks: state.picks,
      revealed: true,
      drawn: state.drawn,
      hits: state.hits,
      hitCount: state.hits.length,
      multiplier: state.multiplier,
    };
  },

  settle(state) {
    return {
      payoutCents: Math.round(state.stakeCents * state.multiplier),
      stakedCents: state.stakeCents,
      breakdown: {
        picks: state.picks,
        hits: state.hits,
        hitCount: state.hits.length,
        multiplier: state.multiplier,
      },
    };
  },
};

/** 给测试用：随机选号 */
export function randomPicks(rng: Rng): number[] {
  const pool = Array.from({ length: POOL_SIZE }, (_, i) => i + 1);
  return rng
    .shuffle(pool)
    .slice(0, PICK_COUNT)
    .sort((a, b) => a - b);
}
