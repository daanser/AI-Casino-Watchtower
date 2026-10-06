/**
 * 龙虎斗
 *
 * 荷官发两张牌：一张给「龙」，一张给「虎」，点数大的一方赢（A=1，J=11，Q=12，K=13）。
 * 同点数算「和」。
 *
 * 用 8 副牌（416 张）模拟真实牌靴，所以两张牌是「不放回」抽取——
 * 和局的真实概率 ≈ 7.47%，不是 1/13 ≈ 7.69%。
 * 龙/虎押注 RTP ≈ 92.5%，和押注 RTP ≈ 67.2%（真实赌场就是这么设计的，和注是陷阱）。
 */

import { PlaygroundError } from '@ai-gaming/shared';
import type { GameAction, GameModule, GameStep } from './types';
import { assertKnownAction } from './types';

const DECKS = 8;
const RANKS = 13;
const SUITS = 4;
const SHOE_SIZE = DECKS * RANKS * SUITS; // 416
const PER_RANK = DECKS * SUITS; // 32

const SUIT_IDS = ['♠', '♥', '♦', '♣'];

/** 牌靴索引 → 点数（1-13）。索引按「点数优先」排布，每个点数 32 张。 */
const rankOfIndex = (i: number): number => Math.floor(i / PER_RANK) + 1;
/** 牌靴索引 → 花色 */
const suitOfIndex = (i: number): number => Math.floor((i % PER_RANK) / DECKS);

const rankLabel = (r: number): string =>
  r === 1 ? 'A' : r === 11 ? 'J' : r === 12 ? 'Q' : r === 13 ? 'K' : String(r);

export interface Card {
  rank: number;
  label: string;
  suit: string;
}

export type DragonTigerBet = 'dragon' | 'tiger' | 'tie';

export interface DragonTigerState {
  /** 本局投入的注额（分） */
  stakeCents: number;
  bet: string;
  dragon: Card;
  tiger: Card;
  revealed: boolean;
  step: number;
}

const BETS: DragonTigerBet[] = ['dragon', 'tiger', 'tie'];

function parseBet(raw: unknown): DragonTigerBet {
  const s = String(raw ?? 'dragon');
  if ((BETS as string[]).includes(s)) return s as DragonTigerBet;
  throw new PlaygroundError('INVALID_ACTION', `不支持的押注位 "${s}"。可用：${BETS.join(' / ')}`);
}

/** 总返还倍数（含本金） */
export function dragonTigerMultiplier(bet: string, dragon: number, tiger: number): number {
  const tie = dragon === tiger;
  if (bet === 'tie') return tie ? 9 : 0; // 8:1
  if (tie) return 0; // 和局通吃龙虎
  if (bet === 'dragon') return dragon > tiger ? 2 : 0; // 1:1
  return tiger > dragon ? 2 : 0;
}

export const dragonTiger: GameModule<DragonTigerState> = {
  meta: {
    id: 'dragon-tiger',
    name: '龙虎斗',
    description:
      '8 副牌（416 张）。荷官发两张牌，一张给龙、一张给虎，点数大的一方赢（A=1，J=11，Q=12，K=13）。' +
      '押中龙或虎返还 2 倍（1:1）；押和返还 9 倍（8:1），但同点数时龙虎注通吃。',
    minBetCents: 100,
    maxBetCents: 100000,
    actions: ['deal'],
    pacing: 'instant',
  },

  init({ rng, params, betCents }) {
    const bet = parseBet(params.bet);

    // 不放回地抽两张：第二张从剩下的 415 张里抽
    const first = rng.int(SHOE_SIZE);
    let second = rng.int(SHOE_SIZE - 1);
    if (second >= first) second += 1; // 跳过已被拿走的那张

    const toCard = (i: number): Card => ({
      rank: rankOfIndex(i),
      label: rankLabel(rankOfIndex(i)),
      suit: SUIT_IDS[suitOfIndex(i)] as string,
    });

    return {
      state: {
        stakeCents: betCents,
        bet,
        dragon: toCard(first),
        tiger: toCard(second),
        revealed: false,
        step: 0,
      },
      events: [{ type: 'bet_placed', payload: { bet }, delayMs: 0 }],
      done: false,
    };
  },

  validate(state, action: GameAction) {
    assertKnownAction(dragonTiger.meta, action);
    if (state.revealed) {
      throw new PlaygroundError('DUPLICATE_ACTION', '这一局已经开过了');
    }
  },

  act(state): GameStep<DragonTigerState> {
    const tie = state.dragon.rank === state.tiger.rank;
    const winner = tie ? 'tie' : state.dragon.rank > state.tiger.rank ? 'dragon' : 'tiger';
    return {
      state: { ...state, revealed: true, step: state.step + 1 },
      events: [
        { type: 'card_dealt', payload: { side: 'dragon', card: state.dragon }, delayMs: 400 },
        { type: 'card_dealt', payload: { side: 'tiger', card: state.tiger }, delayMs: 500 },
        { type: 'showdown', payload: { winner }, delayMs: 600 },
      ],
      done: true,
    };
  },

  /** 开牌之前，两张牌都必须藏住 */
  publicView(state) {
    if (!state.revealed) return { bet: state.bet, revealed: false };
    return {
      bet: state.bet,
      revealed: true,
      dragon: state.dragon,
      tiger: state.tiger,
      winner:
        state.dragon.rank === state.tiger.rank
          ? 'tie'
          : state.dragon.rank > state.tiger.rank
            ? 'dragon'
            : 'tiger',
      multiplier: dragonTigerMultiplier(state.bet, state.dragon.rank, state.tiger.rank),
    };
  },

  settle(state) {
    const multiplier = dragonTigerMultiplier(state.bet, state.dragon.rank, state.tiger.rank);
    return {
      payoutCents: Math.round(state.stakeCents * multiplier),
      stakedCents: state.stakeCents,
      breakdown: {
        bet: state.bet,
        dragon: `${state.dragon.label}${state.dragon.suit}`,
        tiger: `${state.tiger.label}${state.tiger.suit}`,
        multiplier,
        won: multiplier > 0,
      },
    };
  },
};
