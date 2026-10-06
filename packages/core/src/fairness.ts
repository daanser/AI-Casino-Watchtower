/**
 * 公平性：承诺 - 揭示（commit - reveal）
 *
 * 1. 开局前生成 serverSeed，把 sha256(serverSeed) 公开写进 rounds.seed_commit
 * 2. 玩家（或 AI）提供自己的 clientSeed
 * 3. 结算后才公布 serverSeed
 * 4. 任何人都能验算：sha256(公布的 serverSeed) 是否等于开局时那个 commit，
 *    以及用两个种子重跑 RNG 是否能复现出同样的结果
 *
 * 这样服务端在开局之后就无法再挑选结果——它已经把答案的哈希锁死了。
 */

import { createHash, randomBytes } from 'node:crypto';

export const newServerSeed = (): string => randomBytes(32).toString('hex');

export const newClientSeed = (): string => randomBytes(8).toString('hex');

export const commitOf = (serverSeed: string): string =>
  createHash('sha256').update(serverSeed).digest('hex');

export const verifyCommit = (serverSeed: string, commit: string): boolean =>
  commitOf(serverSeed) === commit;

/** 给前端展示的短哈希 */
export const shortHash = (hash: string): string => `${hash.slice(0, 8)}…${hash.slice(-8)}`;
