/**
 * 德州扑克（单挑庄家）
 *
 * 简化版 heads-up：玩家下单注，庄家匹配同额。玩家看自己的两张底牌，
 * 决定弃牌（fold）还是跟注（call）。跟注后翻出公共牌，双方用 7 张牌里
 * 最好的 5 张比大小。暂时不做多轮下注；多 AI 同桌按用户要求留在 P5。
 *
 * 返还：
 *   弃牌 0×（输掉注额）
 *   跟注后赢 2×（拿回自己的注 + 庄家匹配的注）
 *   平局 1×（退回自己的注）
 */

import { PlaygroundError } from '@ai-gaming/shared';
import type { GameAction, GameEventDraft, GameModule, GameStep } from './types';
import { assertKnownAction } from './types';
import { compareHands, evaluateBest, toPokerCard, type HandValue } from './poker';
import type { Rng } from '../rng';

export interface HoldemState {
  stakeCents: number;
  deck: number[];
  player: number[];
  dealer: number[];
  board: number[];
  decision: 'pending' | 'fold' | 'call';
  playerHand: HandValue | null;
  dealerHand: HandValue | null;
  winner: 'player' | 'dealer' | 'tie' | 'fold' | null;
  multiplier: number;
  revealed: boolean;
  step: number;
}

export const holdem: GameModule<HoldemState> = {
  meta: {
    id: 'holdem',
    name: '德州扑克（单挑）',
    description:
      '单挑庄家（heads-up 简化版）。每局下一个固定注额，庄家匹配同额。' +
      '开局只看自己的两张底牌，庄家底牌和公共牌都先藏着。' +
      '动作：fold 弃牌（输掉注额）或 call 跟注（翻开公共牌，双方各用 2 张底牌 + 5 张公共牌里最好的 5 张比牌）。' +
      '跟注后赢返 2 倍，平局退回 1 倍，输返 0。多轮下注暂不支持；多 AI 同桌留到 P5。',
    minBetCents: 100,
    maxBetCents: 100000,
    actions: ['fold', 'call'],
    pacing: 'turnbased',
  },

  init({ rng, betCents }) {
    const deck = rng.shuffle(Array.from({ length: 52 }, (_, i) => i));
    return {
      state: {
        stakeCents: betCents,
        deck,
        player: [deck[0] as number, deck[1] as number],
        dealer: [deck[2] as number, deck[3] as number],
        board: deck.slice(4, 9),
        decision: 'pending',
        playerHand: null,
        dealerHand: null,
        winner: null,
        multiplier: 0,
        revealed: false,
        step: 0,
      },
      events: [{ type: 'hole_cards', payload: { count: 2 }, delayMs: 0 }],
      done: false,
    };
  },

  validate(state, action: GameAction) {
    assertKnownAction(holdem.meta, action);
    if (state.decision !== 'pending' || state.revealed) {
      throw new PlaygroundError('DUPLICATE_ACTION', '这一局已经做过决定了');
    }
  },

  act(state, action): GameStep<HoldemState> {
    if (action.type === 'fold') {
      return {
        state: {
          ...state,
          decision: 'fold',
          winner: 'fold',
          multiplier: 0,
          revealed: true,
          step: state.step + 1,
        },
        events: [{ type: 'fold', payload: {}, delayMs: 350 }],
        done: true,
      };
    }

    const playerHand = evaluateBest([...state.player, ...state.board]);
    const dealerHand = evaluateBest([...state.dealer, ...state.board]);
    const cmp = compareHands(playerHand, dealerHand);
    const winner = cmp > 0 ? 'player' : cmp < 0 ? 'dealer' : 'tie';
    const multiplier = winner === 'player' ? 2 : winner === 'tie' ? 1 : 0;

    const events: GameEventDraft[] = [
      { type: 'call', payload: {}, delayMs: 250 },
      { type: 'flop', payload: { cards: state.board.slice(0, 3).map(toPokerCard) }, delayMs: 650 },
      { type: 'turn', payload: { card: toPokerCard(state.board[3] as number) }, delayMs: 450 },
      { type: 'river', payload: { card: toPokerCard(state.board[4] as number) }, delayMs: 450 },
      {
        type: 'showdown',
        payload: {
          playerHand: playerHand.name,
          dealerHand: dealerHand.name,
          winner,
        },
        delayMs: 550,
      },
    ];

    return {
      state: {
        ...state,
        decision: 'call',
        playerHand,
        dealerHand,
        winner,
        multiplier,
        revealed: true,
        step: state.step + 1,
      },
      events,
      done: true,
    };
  },

  publicView(state) {
    if (!state.revealed) {
      return {
        revealed: false,
        decision: state.decision,
        player: state.player.map(toPokerCard),
        dealerCardCount: 2,
        board: [],
        actions: ['fold', 'call'],
      };
    }
    return {
      revealed: true,
      decision: state.decision,
      player: state.player.map(toPokerCard),
      dealer: state.dealer.map(toPokerCard),
      board: state.decision === 'call' ? state.board.map(toPokerCard) : [],
      playerHand: state.playerHand,
      dealerHand: state.dealerHand,
      winner: state.winner,
      multiplier: state.multiplier,
      actions: [],
    };
  },

  settle(state) {
    return {
      payoutCents: Math.round(state.stakeCents * state.multiplier),
      stakedCents: state.stakeCents,
      breakdown: {
        decision: state.decision,
        winner: state.winner,
        playerHand: state.playerHand?.name ?? null,
        dealerHand: state.dealerHand?.name ?? null,
        multiplier: state.multiplier,
      },
    };
  },
};
