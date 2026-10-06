/**
 * 高低猜（Hi-Lo）
 *
 * 先翻一张牌，猜下一张比当前高还是低。A 最大，2 最小；同点数算猜错。
 * 猜中后潜在返还倍率按该方向的条件概率计算：0.97 / P(猜中)，
 * 所以「猜出现概率很高的方向」赔得少，「猜小概率反转」赔得多，
 * 两边期望返还都约 97%。每次猜中可以继续，也可以收手拿走当前潜在返还。
 *
 * 不换牌：整副 52 张牌预洗入 state，方便确定性回放；下一张牌绝不在 publicView 暴露。
 */

import { PlaygroundError } from '@ai-gaming/shared';
import type { GameAction, GameEventDraft, GameModule, GameStep } from './types';
import { assertKnownAction } from './types';
import { toPokerCard } from './poker';
import type { Rng } from '../rng';

export const MAX_GUESSES = 10;
const FAIR_FACTOR = 0.97;

function valueOf(code: number): number {
  const rank = code % 13;
  return rank === 0 ? 14 : rank + 1;
}

export interface HiLoState {
  stakeCents: number;
  deck: number[];
  position: number;
  current: number;
  seen: number[];
  guesses: number;
  multiplier: number;
  finished: boolean;
  won: boolean | null;
  revealed: boolean;
  step: number;
}

function remainingCounts(state: HiLoState): { higher: number; lower: number; equal: number; total: number } {
  let higher = 0;
  let lower = 0;
  let equal = 0;
  const currentValue = valueOf(state.current);
  for (let i = state.position; i < state.deck.length; i += 1) {
    const v = valueOf(state.deck[i] as number);
    if (v > currentValue) higher += 1;
    else if (v < currentValue) lower += 1;
    else equal += 1;
  }
  return { higher, lower, equal, total: state.deck.length - state.position };
}

function parseType(action: GameAction): 'higher' | 'lower' | 'collect' {
  if (action.type === 'higher' || action.type === 'lower' || action.type === 'collect') return action.type;
  throw new PlaygroundError('INVALID_ACTION', '动作只能是 higher / lower / collect');
}

export const hiLo: GameModule<HiLoState> = {
  meta: {
    id: 'hi-lo',
    name: '高低猜',
    description:
      '当前牌翻开后，猜下一张比它高 (higher) 还是低 (lower)。A 最大，2 最小，同点数算猜错。' +
      '猜中后潜在返还倍率 = 0.97 / 该方向的条件概率；你可以继续猜，或用 collect 收手。' +
      '猜错全输；最多连猜 10 次。每次猜之前，局面会显示上下方向还剩多少张牌（不包含下一张牌的身份）。',
    minBetCents: 100,
    maxBetCents: 100000,
    actions: ['higher', 'lower', 'collect'],
    pacing: 'turnbased',
  },

  init({ rng, betCents }) {
    const deck = rng.shuffle(Array.from({ length: 52 }, (_, i) => i));
    return {
      state: {
        stakeCents: betCents,
        deck,
        position: 1,
        current: deck[0] as number,
        seen: [deck[0] as number],
        guesses: 0,
        multiplier: FAIR_FACTOR,
        finished: false,
        won: null,
        revealed: false,
        step: 0,
      },
      events: [{ type: 'initial_card', payload: { card: toPokerCard(deck[0] as number) }, delayMs: 0 }],
      done: false,
    };
  },

  validate(state, action: GameAction) {
    assertKnownAction(hiLo.meta, action);
    parseType(action);
    if (state.finished || state.revealed) {
      throw new PlaygroundError('DUPLICATE_ACTION', '这一局已经结束了');
    }
    if (action.type !== 'collect' && state.position >= state.deck.length) {
      throw new PlaygroundError('INVALID_ACTION', '牌堆已经用完，只能收手');
    }
  },

  act(state, action): GameStep<HiLoState> {
    const type = parseType(action);
    if (type === 'collect') {
      return {
        state: { ...state, finished: true, won: true, revealed: true, step: state.step + 1 },
        events: [{ type: 'collect', payload: { multiplier: state.multiplier }, delayMs: 250 }],
        done: true,
      };
    }

    const counts = remainingCounts(state);
    const correctCount = type === 'higher' ? counts.higher : counts.lower;
    const probability = counts.total > 0 ? correctCount / counts.total : 0;
    const nextCard = state.deck[state.position] as number;
    const correct = type === 'higher'
      ? valueOf(nextCard) > valueOf(state.current)
      : valueOf(nextCard) < valueOf(state.current);
    const multiplier = correct && probability > 0
      ? Math.min(500, state.multiplier * (FAIR_FACTOR / probability))
      : 0;
    const guesses = state.guesses + 1;
    const events: GameEventDraft[] = [
      { type: 'guess', payload: { direction: type, probability, nextCard: toPokerCard(nextCard) }, delayMs: 350 },
      {
        type: correct ? 'correct' : 'wrong',
        payload: { direction: type, multiplier, guesses },
        delayMs: 350,
      },
    ];

    const maxed = correct && guesses >= MAX_GUESSES;
    if (maxed) events.push({ type: 'max_cashout', payload: { multiplier }, delayMs: 300 });
    const finished = !correct || maxed;

    return {
      state: {
        ...state,
        position: state.position + 1,
        current: nextCard,
        seen: [...state.seen, nextCard],
        guesses,
        multiplier,
        finished,
        won: correct ? true : false,
        revealed: finished,
        step: state.step + 1,
      },
      events,
      done: finished,
    };
  },

  publicView(state) {
    const counts = remainingCounts(state);
    return {
      revealed: state.revealed,
      current: toPokerCard(state.current),
      seen: state.seen.map(toPokerCard),
      guesses: state.guesses,
      maxGuesses: MAX_GUESSES,
      multiplier: state.multiplier,
      probabilities: {
        higher: counts.total > 0 ? counts.higher / counts.total : 0,
        lower: counts.total > 0 ? counts.lower / counts.total : 0,
      },
      remaining: { higher: counts.higher, lower: counts.lower, equal: counts.equal },
      actions: state.finished ? [] : ['higher', 'lower', 'collect'],
      finished: state.finished,
      won: state.won,
      ...(state.revealed && state.position > 1 ? { nextCard: toPokerCard(state.current) } : {}),
    };
  },

  settle(state) {
    const multiplier = state.won ? state.multiplier : 0;
    return {
      payoutCents: Math.round(state.stakeCents * multiplier),
      stakedCents: state.stakeCents,
      breakdown: {
        guesses: state.guesses,
        multiplier,
        won: state.won,
        seen: state.seen,
      },
    };
  },
};
