/**
 * 骰宝（三颗骰子）
 *
 * 押注位挺多，但结构简单：掷三颗骰，按押注位结算。
 *
 * 有一条规则必须记住：**掷出三同号时，「大/小/单/双」全部通吃**。
 * 这不是 bug —— 正因为有这条，庄家才有 2.78% 的edge（0.9722 返还率）。
 *
 * 各押注位理论返还率（已由蒙特卡洛验证）：
 *   大/小/单/双 0.9722   任意三同 0.8611   指定三同 0.8380
 *   指定单骰 0.9213      点数和 0.810~0.903（按点数不同）
 */

import { PlaygroundError } from '@ai-gaming/shared';
import type { GameAction, GameEventDraft, GameModule, GameStep } from './types';
import { assertKnownAction } from './types';

/** 点数和 → 总返还倍数（含本金）。经典赌场赔率表。 */
export const SUM_PAYOUT: Record<number, number> = {
  4: 61,
  5: 31,
  6: 18,
  7: 13,
  8: 9,
  9: 7,
  10: 7,
  11: 7,
  12: 7,
  13: 9,
  14: 13,
  15: 18,
  16: 31,
  17: 61,
};

export function isValidBet(bet: string): boolean {
  if (['big', 'small', 'odd', 'even', 'any-triple'].includes(bet)) return true;
  const m = /^(triple|single):([1-6])$/.exec(bet);
  if (m) return true;
  const s = /^sum:(\d+)$/.exec(bet);
  if (s) {
    const n = Number(s[1]);
    return n >= 4 && n <= 17;
  }
  return false;
}

/**
 * 总返还倍数（含本金）。0 表示输。
 * 这是全游戏唯一一处「结算真相」，publicView 和 settle 都走它。
 */
export function sicboMultiplier(bet: string, dice: number[]): number {
  const total = dice.reduce((a, b) => a + b, 0);
  const isTriple = dice[0] === dice[1] && dice[1] === dice[2];

  if (bet === 'big') return !isTriple && total >= 11 && total <= 17 ? 2 : 0;
  if (bet === 'small') return !isTriple && total >= 4 && total <= 10 ? 2 : 0;
  if (bet === 'odd') return !isTriple && total % 2 === 1 ? 2 : 0;
  if (bet === 'even') return !isTriple && total % 2 === 0 ? 2 : 0;
  if (bet === 'any-triple') return isTriple ? 31 : 0;

  const triple = /^triple:([1-6])$/.exec(bet);
  if (triple) return isTriple && dice[0] === Number(triple[1]) ? 181 : 0;

  const single = /^single:([1-6])$/.exec(bet);
  if (single) {
    const n = Number(single[1]);
    const count = dice.filter((d) => d === n).length;
    // 中 1 个 2 倍、2 个 3 倍、3 个 4 倍
    return count === 0 ? 0 : count + 1;
  }

  const sum = /^sum:(\d+)$/.exec(bet);
  if (sum) {
    const n = Number(sum[1]);
    return total === n ? (SUM_PAYOUT[n] ?? 0) : 0;
  }

  return 0;
}

export interface SicboState {
  stakeCents: number;
  bet: string;
  dice: number[];
  revealed: boolean;
  step: number;
}

function parseBet(raw: unknown): string {
  const b = String(raw ?? 'big');
  if (!isValidBet(b)) {
    throw new PlaygroundError(
      'INVALID_ACTION',
      `不认识的押注位 "${b}"。可用：big / small / odd / even / any-triple / ` +
        `triple:1..6 / single:1..6 / sum:4..17`,
    );
  }
  return b;
}

/** 押注位的中文说明，给前端和 AI 看 */
export function betLabel(bet: string): string {
  if (bet === 'big') return '大 (11-17)';
  if (bet === 'small') return '小 (4-10)';
  if (bet === 'odd') return '单';
  if (bet === 'even') return '双';
  if (bet === 'any-triple') return '任意三同号';
  const t = /^triple:(\d)$/.exec(bet);
  if (t) return `三同号 ${t[1]}${t[1]}${t[1]}`;
  const s = /^single:(\d)$/.exec(bet);
  if (s) return `单骰 ${s[1]}`;
  const u = /^sum:(\d+)$/.exec(bet);
  if (u) return `点数和 = ${u[1]}`;
  return bet;
}

export const sicbo: GameModule<SicboState> = {
  meta: {
    id: 'sicbo',
    name: '骰宝',
    description:
      '掷三颗骰子。押注位：big 大(和值11-17) / small 小(和值4-10) / odd 单 / even 双 / ' +
      'any-triple 任意三同号 / triple:N 指定三同号(N=1..6) / single:N 指定单骰(N=1..6) / ' +
      'sum:N 点数和(N=4..17)。' +
      '押大/小/单/双中返还 2 倍；任意三同号 31 倍；指定三同号 181 倍；' +
      '单骰按命中个数返 2/3/4 倍；点数和按赔率表（4或17 返 61 倍，10或11 返 7 倍）。' +
      '⚠️ 掷出三同号时，大/小/单/双全部通吃。' +
      '押注位在 params 里传，例如 params={"bet":"small"}；动作固定是 roll。',
    minBetCents: 100,
    maxBetCents: 100000,
    actions: ['roll'],
    pacing: 'instant',
  },

  init({ rng, params, betCents }) {
    const bet = parseBet(params.bet);
    const dice = [rng.range(1, 6), rng.range(1, 6), rng.range(1, 6)];
    return {
      state: { stakeCents: betCents, bet, dice, revealed: false, step: 0 },
      events: [{ type: 'bet_placed', payload: { bet, label: betLabel(bet) }, delayMs: 0 }],
      done: false,
    };
  },

  validate(state, action: GameAction) {
    assertKnownAction(sicbo.meta, action);
    if (state.revealed) {
      throw new PlaygroundError('DUPLICATE_ACTION', '这一把已经掷过了');
    }
  },

  act(state): GameStep<SicboState> {
    const total = state.dice.reduce((a, b) => a + b, 0);
    const isTriple = state.dice[0] === state.dice[1] && state.dice[1] === state.dice[2];
    const events: GameEventDraft[] = [
      { type: 'dice_roll', payload: { dice: state.dice }, delayMs: 500 },
      {
        type: 'result',
        payload: {
          dice: state.dice,
          total,
          isTriple,
          multiplier: sicboMultiplier(state.bet, state.dice),
        },
        delayMs: 500,
      },
    ];
    return {
      state: { ...state, revealed: true, step: state.step + 1 },
      events,
      done: true,
    };
  },

  /** 开骰之前，骰子点数一个都不能漏 */
  publicView(state) {
    if (!state.revealed) {
      return { bet: state.bet, betLabel: betLabel(state.bet), revealed: false };
    }
    const total = state.dice.reduce((a, b) => a + b, 0);
    return {
      bet: state.bet,
      betLabel: betLabel(state.bet),
      revealed: true,
      dice: state.dice,
      total,
      isTriple: state.dice[0] === state.dice[1] && state.dice[1] === state.dice[2],
      multiplier: sicboMultiplier(state.bet, state.dice),
    };
  },

  settle(state) {
    const multiplier = sicboMultiplier(state.bet, state.dice);
    return {
      payoutCents: Math.round(state.stakeCents * multiplier),
      stakedCents: state.stakeCents,
      breakdown: {
        bet: state.bet,
        dice: state.dice,
        total: state.dice.reduce((a, b) => a + b, 0),
        multiplier,
      },
    };
  },
};
