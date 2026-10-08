/**
 * 引擎级测试：广播帧
 *
 * 这里守的不是游戏规则，是**前端看到的东西**。帧只在 COMMIT 之后广播，
 * 所以用真库（内存）+ 真总线跑一遍完整回合，看订阅者到底收到了什么。
 *
 * 起因是一个真 bug：结算时只推 round_settled（余额在 balanceAfter 字段里），
 * 不推 wallet_update。前端靠 wallet_update 更新余额条，于是**一直开着页面**
 * 的观众看到的余额永远停在下注后的数字上 —— 第 60 局钱包显示 9,840，
 * 实际是 9,868，差的正好是派彩。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDb, type Db } from '@ai-gaming/db';
import { coins, type ServerFrame } from '@ai-gaming/shared';
import { WalletService } from '../src/wallet';
import { EventBus } from '../src/events';
import { RoundService } from '../src/engine';

function harness() {
  const db: Db = openDb(':memory:');
  migrate(db);
  const wallets = new WalletService(db);
  const wallet = wallets.create({
    ownerType: 'agent',
    ownerId: 'test-bot',
    displayName: '测试选手',
    initialCents: coins(1000),
  });
  const bus = new EventBus();
  const frames: ServerFrame[] = [];
  bus.subscribe((f) => frames.push(f));
  const rounds = new RoundService(db, wallets, bus);
  return { db, wallet, rounds, frames };
}

/** ServerFrame 是联合类型，过滤之后要让 TS 知道剩下的是钱包帧 */
type WalletUpdateFrame = Extract<ServerFrame, { type: 'wallet_update' }>;

const walletFrames = (frames: ServerFrame[], reason: string): WalletUpdateFrame[] =>
  frames.filter(
    (f): f is WalletUpdateFrame => f.type === 'wallet_update' && f.reason === reason,
  );

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 广播是按帧上的时刻排程的（publishTimed），结算帧排在最后。
 * 大火箭在 atMs=0 收手时，最后一条事件是 400ms 的爆炸帧，加上 150ms 的结算间隔，
 * 所以要等 600ms 才能收全。
 */
const SETTLE_SETTLE_MS = 600;

test('结算时广播派彩帧 —— 前端余额靠它才会涨', async () => {
  const { db, wallet, rounds, frames } = harness();
  let checked = 0;

  try {
    for (let i = 0; i < 8; i += 1) {
      frames.length = 0;
      // 大火箭在 atMs=0 收手 = 1.00 倍：崩溃点高于 1.00 就原样退回本金。
      // 崩溃点由种子决定，所以这里不假定输赢，两边都断言。
      const round = await rounds.start({
        walletId: wallet.id,
        gameId: 'crash',
        betCents: coins(10),
        tableId: 'test-table',
        clientSeed: `seed-${i}`,
      });
      const res = await rounds.act(round.id, { type: 'cashout', atMs: 0 }, { actor: '测试选手' });
      await sleep(SETTLE_SETTLE_MS);

      const payouts = walletFrames(frames, 'payout');
      if (res.round.payoutCents > 0) {
        assert.equal(payouts.length, 1, `第 ${i} 局派了 ${res.round.payoutCents} 分，却没广播派彩帧`);
        assert.equal(payouts[0]!.balanceCents, res.balanceAfter, '派彩帧里的余额和实际对不上');
        assert.equal(payouts[0]!.deltaCents, res.round.payoutCents);
        checked += 1;
      } else {
        assert.equal(payouts.length, 0, '全输的局余额没变，不该有派彩帧');
      }
    }
  } finally {
    // 大火箭开局会挂「到点自动炸」的定时器，不撤掉测试进程会被拖住
    rounds.disposeTimelines();
    db.close();
  }

  assert.ok(checked > 0, '8 局一次都没赢，这条用例根本没验证到派彩帧');
});

test('下注帧的余额是「扣注后」的，不是结算后的', async () => {
  const { db, wallet, rounds, frames } = harness();

  try {
    frames.length = 0;
    const round = await rounds.start({
      walletId: wallet.id,
      gameId: 'crash',
      betCents: coins(10),
      tableId: 'test-table',
      clientSeed: 'bet-frame',
    });
    const res = await rounds.act(round.id, { type: 'cashout', atMs: 0 }, { actor: '测试选手' });

    const bets = walletFrames(frames, 'bet');
    assert.equal(bets.length, 1, '下注应该恰好广播一条扣款帧');
    assert.equal(bets[0]!.deltaCents, -coins(10));
    // 扣注后余额 = 1000 - 10 = 990，和结算与否无关 ——
    // 用结算后的余额会让观众看不到「注额被扣走」那一下
    assert.equal(bets[0]!.balanceCents, coins(1000) - coins(10));
    if (res.round.payoutCents > 0) {
      assert.notEqual(bets[0]!.balanceCents, res.balanceAfter, '这一局赢了，下注帧不该等于结算后余额');
    }
  } finally {
    rounds.disposeTimelines();
    db.close();
  }
});

test('事件帧按时刻分帧到达 —— 结算不会抢在过程前面', async () => {
  const { db, wallet, rounds, frames } = harness();

  try {
    const round = await rounds.start({
      walletId: wallet.id,
      gameId: 'roulette',
      betCents: coins(10),
      tableId: 'test-table',
      params: { bet: 'red' },
      clientSeed: 'timed-roulette',
    });
    frames.length = 0;
    await rounds.act(round.id, { type: 'spin' }, { actor: '测试选手' });

    // 轮盘的时间轴是 wheel_spin(200ms) → ball_drop(2000ms)。
    // 刚提交动作时转盘还在转，结果帧不该已经到了 ——
    // 以前这里是「一次性全推」，转盘动画和开球结果同一瞬间抵达，等于没有动画。
    assert.equal(
      frames.filter((f) => f.type === 'round_settled').length,
      0,
      '结算帧和事件帧同时到，前端会先看到结果、再看到过程',
    );

    await sleep(2500);
    assert.equal(
      frames.filter((f) => f.type === 'round_settled').length,
      1,
      '等了 2.5 秒结算帧还是没到',
    );

    // 开球必须排在结算之前
    const order = frames.map((f) => (f.type === 'round_event' ? f.eventType : f.type));
    const drop = order.indexOf('ball_drop');
    const settled = order.indexOf('round_settled');
    assert.ok(drop >= 0 && drop < settled, `开球排在结算之后了：${order.join(' → ')}`);
  } finally {
    rounds.disposeTimelines();
    db.close();
  }
});
