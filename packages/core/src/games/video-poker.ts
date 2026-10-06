/**
 * 视频扑克（Jacks or Better）
 *
 * 一局两步：发 5 张牌 → 玩家选择保留哪些 → 其他位置换牌 → 按最终牌型赔。
 * 赔率表用常见的 9/6 paytable（皇家同花顺返 250，四条 25，葫芦 9……）。
 *
 * 本版不加分币（coin）/ 多注档：下注多少，所有倍率就按该注额缩放。
 */

import { PlaygroundError } from '@ai-gaming/shared';
import type { GameAction, GameEventDraft, GameModule, GameStep } from './types';
import { assertKnownAction } from './types';
import { evaluate5, toPokerCard, videoPokerMultiplier, type HandValue } from './poker';
import type { Rng } from '../rng';

export interface VideoPokerState {
  stakeCents: number;
  deck: number[];
  position: number;
  hand: number[];
  held: number[];
  finalHand: HandValue | null;
  multiplier: number;
  label: string | null;
  stage: 'choose' | 'done';
  revealed: boolean;
  step: number;
}

function parseHold(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    throw new PlaygroundError('INVALID_ACTION', 'hold 必须是 0~4 的数组，例如 [0,2,4]');
  }
  const indices = raw.map(Number);
  if (indices.some((i) => !Number.isInteger(i) || i < 0 || i > 4)) {
    throw new PlaygroundError('INVALID_ACTION', 'hold 里的位置必须是 0~4 的整数');
  }
  if (new Set(indices).size !== indices.length) {
    throw new PlaygroundError('INVALID_ACTION', 'hold 位置不能重复');
  }
  return [...indices].sort((a, b) => a - b);
}

export const videoPoker: GameModule<VideoPokerState> = {
  meta: {
    id: 'video-poker',
    name: '视频扑克',
    description:
      'Jacks or Better：先发 5 张牌，选择要保留的位置（0~4），其他位置各换一张。' +
      '赔率（总返还倍数，含本金）：一对 J 或更好 1×、两对 2×、三条 3×、顺子 4×、同花 6×、葫芦 9×、四条 25×、同花顺 50×、皇家同花顺 250×。' +
      '动作 draw，参数 hold 为要保留的位置数组，例如 action={"type":"draw","hold":[0,1,4]}。',
    minBetCents: 100,
    maxBetCents: 100000,
    actions: ['draw'],
    pacing: 'turnbased',
  },

  init({ rng, betCents }) {
    const deck = rng.shuffle(Array.from({ length: 52 }, (_, i) => i));
    const hand = deck.slice(0, 5);
    return {
      state: {
        stakeCents: betCents,
        deck,
        position: 5,
        hand,
        held: [],
        finalHand: null,
        multiplier: 0,
        label: null,
        stage: 'choose',
        revealed: false,
        step: 0,
      },
      events: [{ type: 'initial_deal', payload: { count: 5 }, delayMs: 0 }],
      done: false,
    };
  },

  validate(state, action: GameAction) {
    assertKnownAction(videoPoker.meta, action);
    if (state.stage !== 'choose' || state.revealed) {
      throw new PlaygroundError('DUPLICATE_ACTION', '已经换过牌了');
    }
    parseHold(action.hold);
  },

  act(state, action): GameStep<VideoPokerState> {
    const held = parseHold(action.hold);
    const hand = state.hand.slice();
    let position = state.position;
    const events: GameEventDraft[] = [
      { type: 'hold', payload: { positions: held }, delayMs: 250 },
    ];

    for (let i = 0; i < 5; i += 1) {
      if (!held.includes(i)) {
        const card = state.deck[position] as number;
        hand[i] = card;
        events.push({
          type: 'replacement',
          payload: { position: i, card: toPokerCard(card) },
          delayMs: 300,
        });
        position += 1;
      }
    }

    const result = videoPokerMultiplier(hand);
    const multiplier = result.multiplier;
    const best = evaluate5(hand);
    events.push({
      type: 'result',
      payload: { hand: hand.map(toPokerCard), handName: best.name, multiplier, label: result.label },
      delayMs: 400,
    });

    return {
      state: {
        ...state,
        position,
        hand,
        held,
        finalHand: best,
        multiplier,
        label: result.label,
        stage: 'done',
        revealed: true,
        step: state.step + 1,
      },
      events,
      done: true,
    };
  },

  publicView(state) {
    return {
      revealed: state.revealed,
      stage: state.stage,
      hand: state.hand.map(toPokerCard),
      held: state.held,
      handName: state.finalHand?.name ?? null,
      multiplier: state.revealed ? state.multiplier : null,
      label: state.revealed ? state.label : null,
      actions: state.stage === 'choose' ? ['draw'] : [],
    };
  },

  settle(state) {
    return {
      payoutCents: Math.round(state.stakeCents * state.multiplier),
      stakedCents: state.stakeCents,
      breakdown: {
        hand: state.hand,
        handName: state.finalHand?.name ?? null,
        multiplier: state.multiplier,
        label: state.label,
      },
    };
  },
};
