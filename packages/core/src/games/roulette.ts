/**
 * 欧式轮盘（单零，37 格）
 *
 * 支持的押注位：
 *   red / black / even / odd / low(1-18) / high(19-36)   → 1:1（总返还 2 倍）
 *   dozen1 / dozen2 / dozen3                             → 2:1（总返还 3 倍）
 *   straight:N（0-36）                                    → 35:1（总返还 36 倍）
 *
 * 0 通吃所有外围注——这是单零轮盘庄家优势的来源，约 2.7%。
 */

import { PlaygroundError } from '@ai-gaming/shared';
import type { GameAction, GameModule, GameStep } from './types';
import { assertKnownAction } from './types';

const POCKETS = 37;

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

const OUTSIDE_BETS = [
  'red',
  'black',
  'even',
  'odd',
  'low',
  'high',
  'dozen1',
  'dozen2',
  'dozen3',
] as const;

export type RouletteBet = (typeof OUTSIDE_BETS)[number] | `straight:${number}`;

export interface RouletteState {
  /** 本局投入的注额（分）。轮盘不会加倍，开局就定死。 */
  stakeCents: number;
  bet: string;
  /** 中奖号码。开局就已定下，但揭示前绝不外泄。 */
  winning: number;
  revealed: boolean;
  step: number;
}

const colorOf = (n: number): 'green' | 'red' | 'black' =>
  n === 0 ? 'green' : RED.has(n) ? 'red' : 'black';

function parseBet(raw: unknown): string {
  const s = String(raw ?? 'red');
  if ((OUTSIDE_BETS as readonly string[]).includes(s)) return s;
  const m = /^straight:(\d{1,2})$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    if (n >= 0 && n <= 36) return s;
  }
  throw new PlaygroundError(
    'INVALID_ACTION',
    `不支持的押注位 "${s}"。可用：${OUTSIDE_BETS.join(' / ')} / straight:0-36`,
  );
}

/** 总返还倍数（含本金）。0 表示输光。 */
export function multiplierOf(bet: string, winning: number): number {
  if (bet.startsWith('straight:')) {
    return Number(bet.slice('straight:'.length)) === winning ? 36 : 0;
  }
  if (winning === 0) return 0; // 0 通吃所有外围注
  switch (bet) {
    case 'red':
      return RED.has(winning) ? 2 : 0;
    case 'black':
      return RED.has(winning) ? 0 : 2;
    case 'even':
      return winning % 2 === 0 ? 2 : 0;
    case 'odd':
      return winning % 2 === 1 ? 2 : 0;
    case 'low':
      return winning <= 18 ? 2 : 0;
    case 'high':
      return winning >= 19 ? 2 : 0;
    case 'dozen1':
      return winning <= 12 ? 3 : 0;
    case 'dozen2':
      return winning <= 24 ? 3 : 0;
    case 'dozen3':
      return winning >= 25 ? 3 : 0;
    default:
      return 0;
  }
}

export const roulette: GameModule<RouletteState> = {
  meta: {
    id: 'roulette',
    name: '欧式轮盘',
    description:
      '单零 37 格（0-36）。先选一个押注位，再转盘开出一个号码。' +
      '红/黑、单/双、大(19-36)/小(1-18) 押中返还 2 倍；打（1-12 / 13-24 / 25-36）返还 3 倍；' +
      '押单个号码返还 36 倍。开出 0 时所有外围注通吃。',
    minBetCents: 100,
    maxBetCents: 100000,
    actions: ['spin'],
    pacing: 'instant',
  },

  init({ rng, params, betCents }) {
    const bet = parseBet(params.bet);
    return {
      state: { stakeCents: betCents, bet, winning: rng.int(POCKETS), revealed: false, step: 0 },
      events: [{ type: 'bet_placed', payload: { bet }, delayMs: 0 }],
      done: false,
    };
  },

  validate(state, action: GameAction) {
    assertKnownAction(roulette.meta, action);
    if (state.revealed) {
      throw new PlaygroundError('DUPLICATE_ACTION', '这一局已经转过了');
    }
  },

  act(state): GameStep<RouletteState> {
    return {
      state: { ...state, revealed: true, step: state.step + 1 },
      events: [
        { type: 'wheel_spin', payload: {}, delayMs: 200 },
        {
          type: 'ball_drop',
          payload: { winning: state.winning, color: colorOf(state.winning) },
          delayMs: 1800,
        },
      ],
      done: true,
    };
  },

  /** 未揭示之前只告诉玩家他押了什么——中奖号码一个字都不能漏 */
  publicView(state) {
    if (!state.revealed) return { bet: state.bet, revealed: false };
    return {
      bet: state.bet,
      revealed: true,
      winning: state.winning,
      color: colorOf(state.winning),
    };
  },

  settle(state) {
    const mult = multiplierOf(state.bet, state.winning);
    return {
      payoutCents: Math.round(state.stakeCents * mult),
      stakedCents: state.stakeCents,
      breakdown: {
        bet: state.bet,
        winning: state.winning,
        color: colorOf(state.winning),
        multiplier: mult,
        won: mult > 0,
      },
    };
  },
};
