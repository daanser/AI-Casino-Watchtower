/**
 * 初始化演示数据。
 *
 * 作用：给「通过 MCP / HTTP 接入的外部 agent」预置几个带本金的钱包，
 *       这样 agent 连上来就能直接下注，不用先自己开户。
 *
 * 幂等：按 owner_id 查重，重复运行不会重复建号。
 *
 * 用法：
 *   npm run seed                    # 默认 3 个外部 agent 钱包，各 1000 筹码
 *   npm run seed -- --coins 5000    # 改初始筹码
 *   npm run seed -- --reset         # 先清空外部 agent 钱包再重建（不动脚本 Bot）
 */

import { migrate, openDb } from '@ai-gaming/db';
import { WalletService } from '@ai-gaming/core';
import { fmtCoins } from '@ai-gaming/shared';

interface SeedSpec {
  ownerId: string;
  displayName: string;
}

const DEFAULT_SEEDS: SeedSpec[] = [
  { ownerId: 'mcp-agent-1', displayName: '外部 AI 一号' },
  { ownerId: 'mcp-agent-2', displayName: '外部 AI 二号' },
  { ownerId: 'mcp-agent-3', displayName: '外部 AI 三号' },
];

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const coins = Number(argValue('--coins') ?? 1000);
  const initialCents = Math.round(coins * 100);
  const reset = process.argv.includes('--reset');

  const db = openDb();
  migrate(db);
  const wallets = new WalletService(db);

  if (reset) {
    for (const s of DEFAULT_SEEDS) {
      const existing = wallets.getByOwner('agent', s.ownerId);
      if (existing) {
        console.log(`  🗑  清空 ${s.displayName}（钱包 #${existing.id}）的余额与流水`);
        // 只删这个钱包的流水，余额归零；不动其他人
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('DELETE FROM transactions WHERE wallet_id = ?').run(existing.id);
          db.prepare('DELETE FROM rounds WHERE wallet_id = ?').run(existing.id);
          db.prepare('UPDATE wallets SET balance_cents = 0 WHERE id = ?').run(existing.id);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      }
    }
  }

  console.log('\n  🌱 初始化外部 agent 钱包\n');

  for (const s of DEFAULT_SEEDS) {
    const existing = wallets.getByOwner('agent', s.ownerId);
    if (existing) {
      // 已经有号了：只补足到目标本金，不覆盖已有余额
      if (existing.balance_cents < initialCents) {
        const topUp = initialCents - existing.balance_cents;
        wallets.apply({
          walletId: existing.id,
          kind: 'grant',
          deltaCents: topUp,
          idemKey: `seed:topup:${existing.id}:${Date.now()}`,
        });
        const after = wallets.getOrThrow(existing.id);
        console.log(
          `  ♻️  ${s.displayName.padEnd(12)} 钱包 #${existing.id}  补足 ${fmtCoins(topUp)} → ${fmtCoins(after.balance_cents)}`,
        );
      } else {
        console.log(
          `  ✓  ${s.displayName.padEnd(12)} 钱包 #${existing.id}  已存在，余额 ${fmtCoins(existing.balance_cents)}`,
        );
      }
      continue;
    }

    const w = wallets.create({
      ownerType: 'agent',
      ownerId: s.ownerId,
      displayName: s.displayName,
      initialCents,
    });
    console.log(`  ✨ ${s.displayName.padEnd(12)} 钱包 #${w.id}  初始 ${fmtCoins(w.balance_cents)}`);
  }

  console.log('\n  MCP 工具里用这些钱包 id 下注即可。示例：');
  const first = wallets.getByOwner('agent', DEFAULT_SEEDS[0].ownerId);
  if (first) {
    console.log(`    pg_quick_bet({ wallet_id: ${first.id}, game_id: "roulette", bet_coins: 10, params: { bet: "red" } })`);
  }
  console.log('');

  db.close();
}

main();
