/**
 * 确定性随机数发生器
 *
 * 同一个 (serverSeed, clientSeed, nonce, step) 永远产生同一串数字。
 * 这是「回放」和「审计」的地基：只要把种子和动作序列记下来，
 * 任何一局都能被逐帧复现，任何人都能验算结果有没有被动过。
 *
 * 实现：HMAC-SHA256 计数器模式。
 *   每次 refill 取 HMAC(serverSeed, `${clientSeed}:${nonce}:${step}:${counter}`) 的 32 字节，
 *   按 4 字节切成 8 个 32 位无符号整数。
 *
 * step 的用途：一局游戏里 init 是 step 0，第一次 act 是 step 1，依此类推。
 * 每一步用独立的随机流，这样「动作次数」不会扰动后续步骤的随机数，
 * 回放时不需要重演前面的消耗量。
 */

import { createHmac } from 'node:crypto';

export interface Rng {
  /** [0, 1) 均匀分布 */
  float(): number;
  /** [min, max) 浮点 */
  floatBetween(min: number, max: number): number;
  /** [0, maxExclusive) 整数，无取模偏差 */
  int(maxExclusive: number): number;
  /** [min, max] 闭区间整数 */
  range(min: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  /** Fisher-Yates 洗牌，返回新数组，不改原数组 */
  shuffle<T>(items: readonly T[]): T[];
  bool(p?: number): boolean;
}

const U32 = 4294967296;

export function makeRng(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  step = 0,
): Rng {
  const message = `${clientSeed}:${nonce}:${step}`;
  let counter = 0;
  let pool = Buffer.alloc(0);
  let offset = 0;

  const refill = (): void => {
    pool = createHmac('sha256', serverSeed).update(`${message}:${counter++}`).digest();
    offset = 0;
  };

  const nextU32 = (): number => {
    if (offset + 4 > pool.length) refill();
    const v = pool.readUInt32BE(offset);
    offset += 4;
    return v;
  };

  const float = (): number => nextU32() / U32;

  // 拒绝采样：直接 % n 会让靠前的数字概率略高，赌场里这是不能接受的
  const int = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`int(n) 需要正整数，收到 ${maxExclusive}`);
    }
    if (maxExclusive === 1) return 0;
    const limit = Math.floor(U32 / maxExclusive) * maxExclusive;
    let v = nextU32();
    while (v >= limit) v = nextU32();
    return v % maxExclusive;
  };

  return {
    float,
    floatBetween: (min, max) => min + float() * (max - min),
    int,
    range: (min, maxInclusive) => min + int(maxInclusive - min + 1),
    pick: <T,>(items: readonly T[]): T => {
      if (items.length === 0) throw new RangeError('pick 收到空数组');
      return items[int(items.length)] as T;
    },
    shuffle: <T,>(items: readonly T[]): T[] => {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        const tmp = out[i] as T;
        out[i] = out[j] as T;
        out[j] = tmp;
      }
      return out;
    },
    bool: (p = 0.5) => float() < p,
  };
}
