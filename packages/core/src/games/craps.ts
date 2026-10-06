/**
 * 花旗骰（过线注 Pass Line）
 *
 * 两阶段游戏，所以是「多步回合制」：
 *   首掷（come-out）：掷出 7 或 11 直接赢；2、3、12 直接输；其余点数成为 point。
 *   point 阶段：掷中 point 赢；掷出 7 输；其余继续掷。
 *
 * 理论返还率 ≈ 0.9859 —— 这是赌场里庄家优势最小的注之一，
 * 也是唯一一个「不需要任何策略就能把 edge 压到 1.4%」的玩法。
 */

import { PlaygroundError } from '@ai-gaming/shared';
import type { GameAction, GameEventDraft, GameModule, GameStep } from './types';
import { assertKnownAction } from './types';
import type { Rng } from '../rng';

const DIE_FACES = 6;

/** 首掷直接赢的点数 */
const NATURAL = [7, 11];
/** 首掷直接输的点数（craps） */
const CRAPS_OUT = [2, 3, 12];

export interface CrapsState {
  stakeCents: number;
  /** null = 还在首掷阶段 */
  point: number | null;
  /** 每一次掷出的两颗骰（[a,b]） */
  rolls: [number, number][];
  finished: boolean;
  /** null = 还没结束 */
  won: boolean | null;
  revealed: boolean;
  step: number;
}

export const craps: GameModule<CrapsState> = {
  meta: {
    id: 'craps',
    name: '花旗骰',
    description:
      '押「过线注」，然后掷两颗骰。' +
      '首掷掷出 7 或 11 直接赢；掷出 2、3、12 直接输；' +
      '掷出其他点数（4/5/6/8/9/10）时该点数成为「point」，需要继续掷 —— ' +
      '再掷中 point 就赢，中途掷出 7 就输。赢返 2 倍（1:1）。' +
      '动作是 roll（掷骰）；没到结局前可以一直 roll。理论返还率约 98.6%。',
    minBetCents: 100,
    maxBetCents: 100000,
    actions: ['roll'],
    pacing: 'turnbased',
  },

  init({ betCents }) {
    return {
      state: {
        stakeCents: betCents,
        point: null,
        rolls: [],
        finished: false,
        won: null,
        revealed: false,
        step: 0,
      },
      events: [{ type: 'come_out', payload: {}, delayMs: 0 }],
      done: false,
    };
  },

  validate(state, action: GameAction) {
    assertKnownAction(craps.meta, action);
    if (state.finished) {
      throw new PlaygroundError('DUPLICATE_ACTION', '这一局已经结束了');
    }
  },

  act(state, _action, rng: Rng): GameStep<CrapsState> {
    const a = rng.range(1, DIE_FACES);
    const b = rng.range(1, DIE_FACES);
    const total = a + b;
    const rolls: [number, number][] = [...state.rolls, [a, b]];

    const events: GameEventDraft[] = [
      { type: 'dice', payload: { a, b, total }, delayMs: 450 },
    ];

    // ── 首掷阶段 ──────────────────────────────────────────────
    if (state.point === null) {
      if (NATURAL.includes(total)) {
        events.push({ type: 'win', payload: { total, reason: 'natural' }, delayMs: 500 });
        return {
          state: { ...state, rolls, finished: true, won: true, revealed: true, step: state.step + 1 },
          events,
          done: true,
        };
      }
      if (CRAPS_OUT.includes(total)) {
        events.push({ type: 'lose', payload: { total, reason: 'craps' }, delayMs: 500 });
        return {
          state: { ...state, rolls, finished: true, won: false, revealed: true, step: state.step + 1 },
          events,
          done: true,
        };
      }
      // 立 point，继续
      events.push({ type: 'point_set', payload: { point: total }, delayMs: 500 });
      return {
        state: { ...state, point: total, rolls, step: state.step + 1 },
        events,
        done: false,
      };
    }

    // ── point 阶段 ────────────────────────────────────────────
    if (total === state.point) {
      events.push({ type: 'win', payload: { total, point: state.point, reason: 'point_hit' }, delayMs: 500 });
      return {
        state: { ...state, rolls, finished: true, won: true, revealed: true, step: state.step + 1 },
        events,
        done: true,
      };
    }
    if (total === 7) {
      events.push({ type: 'lose', payload: { total, point: state.point, reason: 'seven_out' }, delayMs: 500 });
      return {
        state: { ...state, rolls, finished: true, won: false, revealed: true, step: state.step + 1 },
        events,
        done: true,
      };
    }

    events.push({ type: 'roll_again', payload: { total, point: state.point }, delayMs: 450 });
    return {
      state: { ...state, rolls, step: state.step + 1 },
      events,
      done: false,
    };
  },

  /**
   * 骰子是当场掷的，没有「预先定好但藏着」的结果，
   * 所以这里可以放心把已经掷出来的点数全给出去。
   */
  publicView(state) {
    return {
      revealed: state.revealed,
      point: state.point,
      rolls: state.rolls,
      total: state.rolls.length > 0 ? state.rolls[state.rolls.length - 1]![0] + state.rolls[state.rolls.length - 1]![1] : null,
      finished: state.finished,
      won: state.won,
      // 首掷阶段告诉玩家「现在掷出 7/11 就赢」
      phase: state.point === null ? 'come_out' : 'point',
    };
  },

  settle(state) {
    const multiplier = state.won ? 2 : 0;
    return {
      payoutCents: Math.round(state.stakeCents * multiplier),
      stakedCents: state.stakeCents,
      breakdown: {
        won: state.won,
        point: state.point,
        rolls: state.rolls.length,
        multiplier,
      },
    };
  },
};
