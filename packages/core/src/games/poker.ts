/**
 * 扑克牌型评估器 —— 德州扑克与视频扑克共用。
 *
 * 牌编码：0..(副数×52-1)，`rank = code % 13`（0=A … 12=K），
 * `suit = floor((code % 52) / 13)`（0=♠ 1=♥ 2=♦ 3=♣）。
 *
 * ⚠️ 最容易踩的坑：A 的 rank 是 0，但它是**最大的牌**。
 * 凡是拿 rank 直接比大小的地方都必须过一遍 `rankValue()`，
 * 否则「A 高牌」会被算成「最小的高牌」。顺子判断是唯一的例外 ——
 * 那里要用原始 rank，因为 A2345（轮子）的 A 是当 1 用的。
 */

export const RANK_LABELS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUIT_LABELS = ['♠', '♥', '♦', '♣'];

export const rankOf = (code: number): number => code % 13;
export const suitOf = (code: number): number => Math.floor((code % 52) / 13);

/** 比较用的牌力值：A 当成 14，其余就是 rank+1 */
export const rankValue = (rank: number): number => (rank === 0 ? 14 : rank + 1);

export interface PokerCard {
  rank: string;
  suit: string;
  code: number;
  /** 红桃/方块 —— 前端据此上色 */
  red: boolean;
}

export function toPokerCard(code: number): PokerCard {
  const s = suitOf(code);
  return {
    rank: RANK_LABELS[rankOf(code)] as string,
    suit: SUIT_LABELS[s] as string,
    code,
    red: s === 1 || s === 2,
  };
}

/** 牌型，数字越大越强 */
export const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  THREE_OF_A_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_OF_A_KIND: 7,
  STRAIGHT_FLUSH: 8,
  ROYAL_FLUSH: 9,
} as const;

export const CATEGORY_NAMES = [
  '高牌',
  '一对',
  '两对',
  '三条',
  '顺子',
  '同花',
  '葫芦',
  '四条',
  '同花顺',
  '皇家同花顺',
] as const;

export interface HandValue {
  /** 0..9 */
  category: number;
  /** 同牌型时的逐位比较值（已转成 rankValue，降序重要） */
  tiebreak: number[];
  name: string;
}

/** 评估正好 5 张牌 */
export function evaluate5(codes: number[]): HandValue {
  const ranks = codes.map(rankOf);
  const suits = codes.map(suitOf);
  const isFlush = suits.every((s) => s === suits[0]);

  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);

  // 先按出现次数降序，次数相同再按牌力降序
  const groups = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || rankValue(b[0]) - rankValue(a[0]),
  );

  const distinct = [...counts.keys()].sort((a, b) => a - b);

  let straightHigh = -1;
  if (distinct.length === 5) {
    const values = distinct.map(rankValue).sort((a, b) => a - b);
    const span = (values[4] as number) - (values[0] as number);
    if (span === 4) {
      straightHigh = values[4] as number;
    } else if (
      // A2345 轮子：A 当 1，用 5 高算
      distinct[0] === 0 &&
      distinct[1] === 1 &&
      distinct[2] === 2 &&
      distinct[3] === 3 &&
      distinct[4] === 4
    ) {
      straightHigh = 5;
    } else if (
      // 10-J-Q-K-A：A 当 14，是最高的顺子
      distinct[0] === 0 &&
      distinct[1] === 9 &&
      distinct[2] === 10 &&
      distinct[3] === 11 &&
      distinct[4] === 12
    ) {
      straightHigh = 14;
    }
  }

  if (isFlush && straightHigh >= 0) {
    const royal = straightHigh === 14;
    return royal
      ? { category: CATEGORY.ROYAL_FLUSH, tiebreak: [], name: '皇家同花顺' }
      : { category: CATEGORY.STRAIGHT_FLUSH, tiebreak: [straightHigh], name: '同花顺' };
  }

  const [g0, g1, g2] = groups as [number, number][];
  const kickersFrom = (from: number): number[] =>
    groups.slice(from).map((g) => rankValue(g[0])).sort((a, b) => b - a);

  if (g0[1] === 4) {
    return {
      category: CATEGORY.FOUR_OF_A_KIND,
      tiebreak: [rankValue(g0[0]), rankValue((g1 as [number, number])[0])],
      name: '四条',
    };
  }
  if (g0[1] === 3 && g1?.[1] === 2) {
    return {
      category: CATEGORY.FULL_HOUSE,
      tiebreak: [rankValue(g0[0]), rankValue(g1[0])],
      name: '葫芦',
    };
  }
  if (isFlush) {
    return {
      category: CATEGORY.FLUSH,
      tiebreak: distinct.map(rankValue).sort((a, b) => b - a),
      name: '同花',
    };
  }
  if (straightHigh >= 0) {
    return { category: CATEGORY.STRAIGHT, tiebreak: [straightHigh], name: '顺子' };
  }
  if (g0[1] === 3) {
    return {
      category: CATEGORY.THREE_OF_A_KIND,
      tiebreak: [rankValue(g0[0]), ...kickersFrom(1)],
      name: '三条',
    };
  }
  if (g0[1] === 2 && g1?.[1] === 2) {
    const pairs = [rankValue(g0[0]), rankValue(g1[0])].sort((a, b) => b - a);
    return {
      category: CATEGORY.TWO_PAIR,
      tiebreak: [...pairs, rankValue((g2 as [number, number])[0])],
      name: '两对',
    };
  }
  if (g0[1] === 2) {
    return {
      category: CATEGORY.PAIR,
      tiebreak: [rankValue(g0[0]), ...kickersFrom(1)],
      name: '一对',
    };
  }
  return {
    category: CATEGORY.HIGH_CARD,
    tiebreak: distinct.map(rankValue).sort((a, b) => b - a),
    name: '高牌',
  };
}

/** 从 5~7 张里挑出最强的 5 张 */
export function evaluateBest(codes: number[]): HandValue {
  if (codes.length < 5) throw new Error(`至少需要 5 张牌，收到 ${codes.length}`);
  if (codes.length === 5) return evaluate5(codes);

  let best: HandValue | null = null;
  const walk = (start: number, chosen: number[]): void => {
    if (chosen.length === 5) {
      const h = evaluate5(chosen);
      if (!best || compareHands(h, best) > 0) best = h;
      return;
    }
    for (let i = start; i < codes.length; i += 1) {
      chosen.push(codes[i] as number);
      walk(i + 1, chosen);
      chosen.pop();
    }
  };
  walk(0, []);
  return best as unknown as HandValue;
}

/** a > b 返回正数，a < b 返回负数，相等返回 0 */
export function compareHands(a: HandValue, b: HandValue): number {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i += 1) {
    const x = a.tiebreak[i] ?? 0;
    const y = b.tiebreak[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * 视频扑克（Jacks or Better）用：这一手牌值多少注。
 * 一对必须 ≥ J 才赔 —— 这正是「Jacks or Better」名字的由来。
 */
export const JACKS_OR_BETTER_PAYTABLE: { category: number; pay: number; label: string }[] = [
  { category: CATEGORY.ROYAL_FLUSH, pay: 250, label: '皇家同花顺' },
  { category: CATEGORY.STRAIGHT_FLUSH, pay: 50, label: '同花顺' },
  { category: CATEGORY.FOUR_OF_A_KIND, pay: 25, label: '四条' },
  { category: CATEGORY.FULL_HOUSE, pay: 9, label: '葫芦' },
  { category: CATEGORY.FLUSH, pay: 6, label: '同花' },
  { category: CATEGORY.STRAIGHT, pay: 4, label: '顺子' },
  { category: CATEGORY.THREE_OF_A_KIND, pay: 3, label: '三条' },
  { category: CATEGORY.TWO_PAIR, pay: 2, label: '两对' },
  { category: CATEGORY.PAIR, pay: 1, label: '一对 J 或更好' },
];

/** 返回总返还倍数（含本金）。0 = 不中。 */
export function videoPokerMultiplier(codes: number[]): { multiplier: number; label: string } {
  const h = evaluate5(codes);
  if (h.category === CATEGORY.PAIR) {
    const pairRank = h.tiebreak[0] ?? 0;
    // rankValue: J=11 Q=12 K=13 A=14
    if (pairRank < 11) return { multiplier: 0, label: '一对但小于 J，不赔' };
    return { multiplier: 1, label: '一对 J 或更好' };
  }
  const row = JACKS_OR_BETTER_PAYTABLE.find((r) => r.category === h.category);
  if (!row) return { multiplier: 0, label: h.name };
  return { multiplier: row.pay, label: row.label };
}
