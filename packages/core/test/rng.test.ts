/**
 * 确定性 RNG 与公平性测试
 *
 * 最要紧的一条：同一组种子必须永远给出同一串数字。
 * 这条一旦不成立，回放和审计就全废了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../src/rng';
import { commitOf, newServerSeed, verifyCommit } from '../src/fairness';

test('同种子同结果：两串完全一致', () => {
  const a = makeRng('server-abc', 'client-xyz', 7, 0);
  const b = makeRng('server-abc', 'client-xyz', 7, 0);
  const seqA = Array.from({ length: 200 }, () => a.int(1000));
  const seqB = Array.from({ length: 200 }, () => b.int(1000));
  assert.deepEqual(seqA, seqB);
});

test('换任意一个输入都会改变结果', () => {
  const base = Array.from({ length: 50 }, (() => {
    const r = makeRng('s1', 'c1', 1, 0);
    return () => r.int(1_000_000);
  })());

  const variants = [
    makeRng('s2', 'c1', 1, 0),
    makeRng('s1', 'c2', 1, 0),
    makeRng('s1', 'c1', 2, 0),
    makeRng('s1', 'c1', 1, 1),
  ];
  for (const v of variants) {
    const other = Array.from({ length: 50 }, () => v.int(1_000_000));
    assert.notDeepEqual(base, other);
  }
});

test('每一步用独立随机流：step 之间互不影响', () => {
  // 同一个 step 反复取，序列必须稳定 —— 这样「动作次数」不会扰动后续步骤
  const first = Array.from({ length: 10 }, () => makeRng('s', 'c', 1, 3).int(100));
  assert.ok(first.every((v) => v === first[0]));
});

test('int() 落在区间内且覆盖均匀', () => {
  const rng = makeRng('seed', 'client', 1, 0);
  const buckets = new Array(6).fill(0);
  const N = 60_000;
  for (let i = 0; i < N; i++) {
    const v = rng.int(6);
    assert.ok(v >= 0 && v < 6, `越界: ${v}`);
    buckets[v]++;
  }
  // 每个桶理论值 10000，允许 ±8% 波动
  for (const b of buckets) {
    assert.ok(Math.abs(b - N / 6) < (N / 6) * 0.08, `分布不均: ${buckets.join(',')}`);
  }
});

test('int(0) 和 int(-1) 必须报错，而不是悄悄返回垃圾', () => {
  const rng = makeRng('s', 'c', 1, 0);
  assert.throws(() => rng.int(0));
  assert.throws(() => rng.int(-1));
  assert.throws(() => rng.int(1.5));
});

test('shuffle 不打乱元素集合，且是确定性的', () => {
  const items = Array.from({ length: 52 }, (_, i) => i);
  const a = makeRng('s', 'c', 1, 0).shuffle(items);
  const b = makeRng('s', 'c', 1, 0).shuffle(items);
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort((x, y) => x - y), items);
  assert.notDeepEqual(a, items, '52 张牌原样返回的概率极低，说明洗牌没生效');
});

test('承诺-揭示：哈希对得上，改一个字符就对不上', () => {
  const seed = newServerSeed();
  const commit = commitOf(seed);
  assert.equal(commit.length, 64);
  assert.ok(verifyCommit(seed, commit));
  assert.ok(!verifyCommit(`${seed}0`, commit));
  assert.ok(!verifyCommit(newServerSeed(), commit));
});
