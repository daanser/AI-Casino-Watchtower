/**
 * 百家乐（8 副牌）
 *
 * 规则是死的：闲家、庄家各发两张，按固定表补第三张，玩家只选押哪一边。
 * 正因为没有决策空间，它才特别适合当「AI 判断力」的对照组 ——
 * 唯一能体现水平的地方就是押注位选择和资金管理。
 *
 * 返还率（理论值，已由蒙特卡洛验证）：
 *   押闲 ≈ 0.9876   押庄 ≈ 0.9894（抽水 5%）  押和 ≈ 0.8556
 */

import { PlaygroundError } from '@ai-gaming/shared';
import type { GameAction, GameEventDraft, GameModule, GameStep } from './types';
import { assertKnownAction } from './types';
import { toPokerCard } from './poker';
import type { Rng } from '../rng';

const DECKS = 8;
const SHOE_SIZE = DECKS * 52;

export type BaccaratBet = 'player' | 'banker' | 'tie';

const BETS: BaccaratBet[] = ['player', 'banker', 'tie'];

/** 单张牌的点数：A=1，10/J/Q/K=0，其余按面值 */
export function cardPoints(code: number): number {
  const r = code % 13;
  if (r === 0) return 1;
  if (r >= 9) return 0;
  return r + 1;
}

/** 手牌点数：个位（超过 9 就减 10） */
export function baccaratTotal(cards: number[]): number {
  return cards.reduce((s, c) => s + cardPoints(c), 0) % 10;
}

export interface BaccaratState {
  stakeCents: number;
  bet: BaccaratBet;
  player: number[];
  banker: number[];
  /** 闲家第三张（没补就是 null），庄家补牌规则要用它 */
  playerThird: number | null;
  bankerThird: number | null;
  revealed: boolean;
  step: number;
}

function parseBet(raw: unknown): BaccaratBet {
  const b = String(raw ?? 'player') as BaccaratBet;
  if (!BETS.includes(b)) {
    throw new PlaygroundError(
      'INVALID_ACTION',
      `押注位只能是 ${BETS.join(' / ')}，收到 "${String(raw)}"`,
    );
  }
  return b;
}

/** 从整双鞋里不放回地抽牌 */
function makeDrawer(rng: Rng): () => number {
  const used = new Set<number>();
  return () => {
    let c = rng.int(SHOE_SIZE);
    while (used.has(c)) c = rng.int(SHOE_SIZE);
    used.add(c);
    return c;
  };
}

export function baccaratWinner(
  playerTotal: number,
  bankerTotal: number,
): 'player' | 'banker' | 'tie' {
  if (playerTotal === bankerTotal) return 'tie';
  return playerTotal > bankerTotal ? 'player' : 'banker';
}

export const baccarat: GameModule<BaccaratState> = {
  meta: {
    id: 'baccarat',
    name: '百家乐',
    description:
      '8 副牌。闲家与庄家各发两张，点数（个位）更接近 9 的一方赢。' +
      '闲家 0-5 点必补一张，庄家按闲家第三张的点数决定是否补牌（规则固定，玩家无决策）。' +
      '押闲中 2 倍；押庄中 1.95 倍（抽水 5%）；押和中 9 倍。' +
      '和局时押庄/押闲退回本金。押注位在 params 里传，例如 params={"bet":"banker"}；动作固定是 deal。',
    minBetCents: 100,
    maxBetCents: 100000,
    actions: ['deal'],
    pacing: 'instant',
  },

  init({ rng, params, betCents }) {
    const bet = parseBet(params.bet);
    const draw = makeDrawer(rng);

    const player = [draw(), draw()];
    const banker = [draw(), draw()];

    // ── 补牌规则（全球统一下注表）─────────────────────────────
    let playerThird: number | null = null;
    if (baccaratTotal(player) <= 5) {
      playerThird = draw();
      player.push(playerThird);
    }

    const bTotal = baccaratTotal(banker);
    const p3 = playerThird === null ? null : cardPoints(playerThird);

    let bankerDraws: boolean;
    if (p3 === null) {
      // 闲家没补牌 → 庄家单纯按自己的点数
      bankerDraws = bTotal <= 5;
    } else if (bTotal <= 2) {
      bankerDraws = true;
    } else if (bTotal === 3) {
      bankerDraws = p3 !== 8;
    } else if (bTotal === 4) {
      bankerDraws = p3 >= 2 && p3 <= 7;
    } else if (bTotal === 5) {
      bankerDraws = p3 >= 4 && p3 <= 7;
    } else if (bTotal === 6) {
      bankerDraws = p3 >= 6 && p3 <= 7;
    } else {
      bankerDraws = false; // 7 点必停
    }

    let bankerThird: number | null = null;
    if (bankerDraws) {
      bankerThird = draw();
      banker.push(bankerThird);
    }

    return {
      state: {
        stakeCents: betCents,
        bet,
        player,
        banker,
        playerThird,
        bankerThird,
        revealed: false,
        step: 0,
      },
      events: [{ type: 'bet_placed', payload: { bet }, delayMs: 0 }],
      done: false,
    };
  },

  validate(state, action: GameAction) {
    assertKnownAction(baccarat.meta, action);
    if (state.revealed) {
      throw new PlaygroundError('DUPLICATE_ACTION', '这一局已经开过了');
    }
  },

  act(state): GameStep<BaccaratState> {
    const events: GameEventDraft[] = [];
    // 逐张亮牌：闲1 庄1 闲2 庄2（补牌另算），牌桌上的节奏就是这样
    const order: { side: 'player' | 'banker'; idx: number }[] = [
      { side: 'player', idx: 0 },
      { side: 'banker', idx: 0 },
      { side: 'player', idx: 1 },
      { side: 'banker', idx: 1 },
    ];
    for (const o of order) {
      const card = state[o.side][o.idx] as number;
      events.push({
        type: 'card_dealt',
        payload: { side: o.side, card: toPokerCard(card), index: o.idx },
        delayMs: 320,
      });
    }
    if (state.playerThird !== null) {
      events.push({
        type: 'card_dealt',
        payload: { side: 'player', card: toPokerCard(state.playerThird), index: 2, third: true },
        delayMs: 400,
      });
    }
    if (state.bankerThird !== null) {
      events.push({
        type: 'card_dealt',
        payload: { side: 'banker', card: toPokerCard(state.bankerThird), index: 2, third: true },
        delayMs: 400,
      });
    }

    const p = baccaratTotal(state.player);
    const b = baccaratTotal(state.banker);
    events.push({
      type: 'showdown',
      payload: { playerTotal: p, bankerTotal: b, winner: baccaratWinner(p, b) },
      delayMs: 500,
    });

    return {
      state: { ...state, revealed: true, step: state.step + 1 },
      events,
      done: true,
    };
  },

  /** 亮牌之前只告诉玩家他押了哪边 */
  publicView(state) {
    if (!state.revealed) return { bet: state.bet, revealed: false };
    const p = baccaratTotal(state.player);
    const b = baccaratTotal(state.banker);
    return {
      bet: state.bet,
      revealed: true,
      player: state.player.map(toPokerCard),
      banker: state.banker.map(toPokerCard),
      playerTotal: p,
      bankerTotal: b,
      winner: baccaratWinner(p, b),
      multiplier: baccaratMultiplier(state.bet, p, b),
    };
  },

  settle(state) {
    const p = baccaratTotal(state.player);
    const b = baccaratTotal(state.banker);
    const multiplier = baccaratMultiplier(state.bet, p, b);
    return {
      payoutCents: Math.round(state.stakeCents * multiplier),
      stakedCents: state.stakeCents,
      breakdown: {
        bet: state.bet,
        playerTotal: p,
        bankerTotal: b,
        winner: baccaratWinner(p, b),
        multiplier,
      },
    };
  },
};

/** 总返还倍数（含本金） */
export function baccaratMultiplier(bet: BaccaratBet, playerTotal: number, bankerTotal: number): number {
  const winner = baccaratWinner(playerTotal, bankerTotal);
  if (winner === 'tie') {
    // 和局：押和 8:1；押庄/押闲原样退回
    return bet === 'tie' ? 9 : 1;
  }
  if (winner === 'player') return bet === 'player' ? 2 : 0;
  return bet === 'banker' ? 1.95 : 0;
}
