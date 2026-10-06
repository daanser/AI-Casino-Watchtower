/**
 * 黑杰克（21 点）
 *
 * 6 副牌（312 张），开局一次性洗好存进 state —— 所以「抽牌」是位置式的，
 * 不依赖任何后续随机数，回放必然一致。
 *
 * 关键规则：
 *   - A 算 1 或 11（自动选不爆的那个）
 *   - J/Q/K 算 10
 *   - 前两张就 21 点 = 黑杰克，赔 3:2（总返还 2.5 倍）
 *   - double：追加等额注额，只发一张牌，然后必须停牌
 *   - 庄家点数 < 17 必须要牌，≥ 17 停牌
 *
 * 隐藏信息：庄家第二张是暗牌，revealed 之前 publicView 里只有第一张。
 */

import { PlaygroundError } from '@ai-gaming/shared';
import type { GameAction, GameEventDraft, GameModule, GameStep } from './types';
import { assertKnownAction } from './types';

const DECKS = 6;
const SHOE_SIZE = DECKS * 52;

const RANK_LABELS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUIT_LABELS = ['♠', '♥', '♦', '♣'];

/** 牌编码：deck*52 + suit*13 + rank（rank: 0=A … 12=K） */
const rankOfCode = (c: number): number => c % 13;
const suitOfCode = (c: number): number => Math.floor((c % 52) / 13);

export interface BjCard {
  rank: string;
  suit: string;
}

const toCard = (code: number): BjCard => ({
  rank: RANK_LABELS[rankOfCode(code)] as string,
  suit: SUIT_LABELS[suitOfCode(code)] as string,
});

/** 手牌点数。A 先按 11 算，爆了再往下降 10。 */
export function handValue(cards: number[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    const r = rankOfCode(c);
    if (r === 0) {
      aces += 1;
      total += 11;
    } else if (r >= 9) {
      total += 10;
    } else {
      total += r + 1;
    }
  }
  let softAces = aces;
  while (total > 21 && softAces > 0) {
    total -= 10;
    softAces -= 1;
  }
  return { total, soft: softAces > 0 };
}

const isBlackjack = (cards: number[]): boolean =>
  cards.length === 2 && handValue(cards).total === 21;

export interface BlackjackState {
  stakeCents: number;
  shoe: number[];
  drawn: number;
  player: number[];
  dealer: number[];
  /** 庄家暗牌是否已翻开 */
  revealed: boolean;
  finished: boolean;
  doubled: boolean;
  step: number;
}

/** 庄家回合：先翻暗牌，再一路补到 17 点以上 */
function dealerPlay(
  dealer: number[],
  draw: () => number,
): { dealer: number[]; events: GameEventDraft[] } {
  const events: GameEventDraft[] = [
    { type: 'reveal', payload: { card: toCard(dealer[1] as number) }, delayMs: 500 },
  ];
  const cards = dealer.slice();
  while (handValue(cards).total < 17) {
    const card = draw();
    cards.push(card);
    events.push({ type: 'deal', payload: { side: 'dealer', card: toCard(card) }, delayMs: 550 });
  }
  return { dealer: cards, events };
}

export const blackjack: GameModule<BlackjackState> = {
  meta: {
    id: 'blackjack',
    name: '黑杰克',
    description:
      '6 副牌。你和庄家各发两张，庄家一张明牌一张暗牌。目标是让点数尽量接近 21 但不爆。' +
      'A 算 1 或 11，J/Q/K 算 10。可用动作：hit（要牌）、stand（停牌）、' +
      'double（加倍，只能在前两张时用，追加等额注额后只发一张牌并自动停牌）。' +
      '前两张凑到 21 点叫黑杰克，赔 3:2。庄家不到 17 点必须要牌。',
    minBetCents: 100,
    maxBetCents: 100000,
    actions: ['hit', 'stand', 'double'],
    pacing: 'turnbased',
  },

  init({ rng, betCents }) {
    const shoe = rng.shuffle(Array.from({ length: SHOE_SIZE }, (_, i) => i));
    let drawn = 0;
    const draw = (): number => shoe[drawn++] as number;

    const player = [draw(), draw()];
    const dealer = [draw(), draw()];
    const playerBJ = isBlackjack(player);

    const events: GameEventDraft[] = [
      { type: 'deal', payload: { side: 'player', card: toCard(player[0] as number) }, delayMs: 300 },
      { type: 'deal', payload: { side: 'dealer', card: toCard(dealer[0] as number) }, delayMs: 350 },
      { type: 'deal', payload: { side: 'player', card: toCard(player[1] as number) }, delayMs: 350 },
      { type: 'deal', payload: { side: 'dealer', back: true }, delayMs: 350 },
    ];

    if (playerBJ) {
      events.push({ type: 'blackjack', payload: {}, delayMs: 500 });
    }

    return {
      state: {
        stakeCents: betCents,
        shoe,
        drawn,
        player,
        dealer,
        // 拿到黑杰克就直接开牌结算，不再进入要牌阶段
        revealed: playerBJ,
        finished: playerBJ,
        doubled: false,
        step: 0,
      },
      events,
      done: playerBJ,
    };
  },

  validate(state, action: GameAction) {
    assertKnownAction(blackjack.meta, action);
    if (state.finished) {
      throw new PlaygroundError('DUPLICATE_ACTION', '这一局已经结束了');
    }
    if (action.type === 'double' && state.player.length !== 2) {
      throw new PlaygroundError('INVALID_ACTION', '只有手上正好两张牌时才能加倍');
    }
  },

  act(state, action): GameStep<BlackjackState> {
    let drawn = state.drawn;
    const draw = (): number => state.shoe[drawn++] as number;

    const player = state.player.slice();
    let dealer = state.dealer.slice();
    const events: GameEventDraft[] = [];

    let stakeDeltaCents = 0;
    let doubled = state.doubled;
    let finished = false;
    let revealed = false;

    if (action.type === 'hit') {
      const card = draw();
      player.push(card);
      events.push({ type: 'deal', payload: { side: 'player', card: toCard(card) }, delayMs: 500 });

      const v = handValue(player);
      if (v.total > 21) {
        events.push({ type: 'bust', payload: { total: v.total }, delayMs: 500 });
        finished = true;
        revealed = true;
      }
    } else if (action.type === 'double') {
      // 追加等额注额，引擎会额外扣钱并记账
      stakeDeltaCents = state.stakeCents;
      doubled = true;
      const card = draw();
      player.push(card);
      events.push({ type: 'double', payload: {}, delayMs: 300 });
      events.push({ type: 'deal', payload: { side: 'player', card: toCard(card) }, delayMs: 400 });

      const r = dealerPlay(dealer, draw);
      dealer = r.dealer;
      events.push(...r.events);
      finished = true;
      revealed = true;
    } else {
      // stand
      const r = dealerPlay(dealer, draw);
      dealer = r.dealer;
      events.push(...r.events);
      finished = true;
      revealed = true;
    }

    return {
      state: {
        ...state,
        drawn,
        player,
        dealer,
        revealed,
        finished,
        doubled,
        step: state.step + 1,
      },
      events,
      done: finished,
      stakeDeltaCents,
    };
  },

  publicView(state) {
    const pv = handValue(state.player);
    const dealerVisible = state.revealed
      ? state.dealer.map(toCard)
      : [toCard(state.dealer[0] as number)];

    return {
      revealed: state.revealed,
      finished: state.finished,
      doubled: state.doubled,
      player: state.player.map(toCard),
      playerTotal: pv.total,
      playerSoft: pv.soft,
      playerBlackjack: isBlackjack(state.player),
      /** 暗牌没翻开之前，这里只有一张 */
      dealer: dealerVisible,
      dealerTotal: state.revealed ? handValue(state.dealer).total : null,
      /** 当前可用的动作 —— AI 直接照着这个选就行 */
      actions: state.finished
        ? []
        : state.player.length === 2
          ? ['hit', 'stand', 'double']
          : ['hit', 'stand'],
    };
  },

  settle(state) {
    const pv = handValue(state.player).total;
    const dv = handValue(state.dealer).total;
    const playerBJ = isBlackjack(state.player);
    const dealerBJ = isBlackjack(state.dealer);

    let multiplier: number;
    let outcome: string;

    if (pv > 21) {
      multiplier = 0;
      outcome = 'bust';
    } else if (playerBJ && dealerBJ) {
      multiplier = 1;
      outcome = 'push';
    } else if (playerBJ) {
      multiplier = 2.5; // 黑杰克赔 3:2
      outcome = 'blackjack';
    } else if (dealerBJ) {
      multiplier = 0;
      outcome = 'dealer_blackjack';
    } else if (dv > 21) {
      multiplier = 2;
      outcome = 'dealer_bust';
    } else if (pv > dv) {
      multiplier = 2;
      outcome = 'win';
    } else if (pv === dv) {
      multiplier = 1;
      outcome = 'push';
    } else {
      multiplier = 0;
      outcome = 'lose';
    }

    return {
      payoutCents: Math.round(state.stakeCents * multiplier),
      stakedCents: state.stakeCents,
      breakdown: {
        playerTotal: pv,
        dealerTotal: dv,
        outcome,
        multiplier,
        doubled: state.doubled,
        won: multiplier > 1,
      },
    };
  },
};
