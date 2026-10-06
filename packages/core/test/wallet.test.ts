/**
 * 钱包账本测试
 *
 * 这些断言守的是整套系统的钱袋子。任何一条挂了都不许往下做。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDb, type Db } from '@ai-gaming/db';
import { WalletService } from '../src/wallet';
import { coins } from '@ai-gaming/shared';

function freshDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('建钱包即发初始筹码，且留了流水', () => {
  const db = freshDb();
  const w = new WalletService(db);

  const wallet = w.create({
    ownerType: 'agent',
    ownerId: 'bot-1',
    displayName: '测试机器人',
    initialCents: coins(1000),
  });

  assert.equal(wallet.balance_cents, coins(1000));
  const txs = w.transactions(wallet.id);
  assert.equal(txs.length, 1);
  assert.equal(txs[0]!.kind, 'grant');
  assert.equal(txs[0]!.delta_cents, coins(1000));
  assert.ok(w.reconcile(wallet.id).ok);
  db.close();
});

test('下注扣钱、派彩加钱，账本始终对得上', () => {
  const db = freshDb();
  const w = new WalletService(db);
  const wallet = w.create({
    ownerType: 'agent',
    ownerId: 'bot-2',
    displayName: '机器人二号',
    initialCents: coins(100),
  });

  w.apply({ walletId: wallet.id, kind: 'bet', deltaCents: -coins(10), idemKey: 'r1:bet' });
  assert.equal(w.getOrThrow(wallet.id).balance_cents, coins(90));

  w.apply({ walletId: wallet.id, kind: 'payout', deltaCents: coins(20), idemKey: 'r1:payout' });
  assert.equal(w.getOrThrow(wallet.id).balance_cents, coins(110));

  const rec = w.reconcile(wallet.id);
  assert.ok(rec.ok, `对账失败: 余额 ${rec.balanceCents} vs 流水 ${rec.ledgerSumCents}`);
  db.close();
});

test('幂等键：同一个键重复提交只扣一次钱', () => {
  const db = freshDb();
  const w = new WalletService(db);
  const wallet = w.create({
    ownerType: 'agent',
    ownerId: 'bot-3',
    displayName: '机器人三号',
    initialCents: coins(100),
  });

  const first = w.apply({
    walletId: wallet.id,
    kind: 'bet',
    deltaCents: -coins(30),
    idemKey: 'r9:bet',
  });
  assert.equal(first.duplicated, false);

  // 模拟网络重试：同一个幂等键再来一次
  const second = w.apply({
    walletId: wallet.id,
    kind: 'bet',
    deltaCents: -coins(30),
    idemKey: 'r9:bet',
  });
  assert.equal(second.duplicated, true);
  assert.equal(second.balanceAfter, coins(70));
  assert.equal(w.getOrThrow(wallet.id).balance_cents, coins(70), '重复提交把钱扣了两次');

  // 只有一条流水
  assert.equal(w.transactions(wallet.id).filter((t) => t.kind === 'bet').length, 1);
  db.close();
});

test('余额不足必须拒绝，且数据库层面也不允许负余额', () => {
  const db = freshDb();
  const w = new WalletService(db);
  const wallet = w.create({
    ownerType: 'agent',
    ownerId: 'bot-4',
    displayName: '机器人四号',
    initialCents: coins(10),
  });

  assert.throws(
    () => w.apply({ walletId: wallet.id, kind: 'bet', deltaCents: -coins(11) }),
    /余额不足/,
  );
  assert.equal(w.getOrThrow(wallet.id).balance_cents, coins(10));

  // 就算绕过服务层直接改库，CHECK 约束也会拦住
  assert.throws(() => db.exec('UPDATE wallets SET balance_cents = -1'));
  db.close();
});

test('金额必须是整数分，浮点一律拒绝', () => {
  const db = freshDb();
  const w = new WalletService(db);
  const wallet = w.create({
    ownerType: 'agent',
    ownerId: 'bot-5',
    displayName: '机器人五号',
    initialCents: coins(10),
  });

  assert.throws(
    () => w.apply({ walletId: wallet.id, kind: 'bet', deltaCents: -10.5 }),
    /必须是整数/,
  );
  db.close();
});

test('转账两边都留痕，总额守恒', () => {
  const db = freshDb();
  const w = new WalletService(db);
  const a = w.create({ ownerType: 'agent', ownerId: 'a', displayName: 'A', initialCents: coins(100) });
  const b = w.create({ ownerType: 'agent', ownerId: 'b', displayName: 'B', initialCents: coins(0) });

  w.transfer(a.id, b.id, coins(40), 'xfer-1');

  assert.equal(w.getOrThrow(a.id).balance_cents, coins(60));
  assert.equal(w.getOrThrow(b.id).balance_cents, coins(40));
  assert.ok(w.reconcileAll().every((r) => r.ok));
  db.close();
});

test('并发下注：20 个钱包同时扣注，余额分毫不差', () => {
  const db = freshDb();
  const w = new WalletService(db);
  const wallets = Array.from({ length: 20 }, (_, i) =>
    w.create({
      ownerType: 'agent',
      ownerId: `par-${i}`,
      displayName: `并行机器人 ${i}`,
      initialCents: coins(50),
    }),
  );

  // 每个钱包各扣 30 次 1 分
  for (const wallet of wallets) {
    for (let i = 0; i < 30; i++) {
      w.apply({
        walletId: wallet.id,
        kind: 'bet',
        deltaCents: -1,
        idemKey: `w${wallet.id}:n${i}`,
      });
    }
  }

  for (const wallet of wallets) {
    assert.equal(w.getOrThrow(wallet.id).balance_cents, coins(50) - 30);
  }
  assert.ok(w.reconcileAll().every((r) => r.ok), '并行扣注后账本对不上');
  db.close();
});
