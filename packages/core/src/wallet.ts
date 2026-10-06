/**
 * 钱包与账本服务
 *
 * 三条铁律（改代码时请务必守住）：
 *   1. 余额只能通过 apply() 变动。任何地方都不允许裸 UPDATE wallets.balance_cents。
 *   2. 每一次余额变动必须在 transactions 留一条痕，并且记下变动后的余额。
 *   3. 下注 / 结算这类操作必须带幂等键，网络重试不能重复扣钱。
 *
 * 关于并发：node:sqlite 是同步 API，Node 又是单线程，所以一个同步事务块
 * 不可能被另一个事务插进来——「单写者」这件事是语言层面就保证了的。
 * 显式互斥锁见 engine.ts 的 WriteLock：它保护的是「整个回合生命周期」这种
 * 多步骤流程，万一以后游戏逻辑里出现了 await，那道锁就是防线。
 */

import {
  PlaygroundError,
  type Cents,
  type TransactionRow,
  type TxKind,
  type WalletOwnerType,
  type WalletRow,
} from '@ai-gaming/shared';
import { all, one, run, tx, type Db } from '@ai-gaming/db';

export interface CreateWalletInput {
  ownerType: WalletOwnerType;
  ownerId: string;
  displayName: string;
  initialCents?: Cents;
}

export interface ApplyTxInput {
  walletId: number;
  kind: TxKind;
  deltaCents: Cents;
  roundId?: number | null;
  /** 幂等键。同一个 key 第二次调用不会重复生效，直接返回第一次的结果。 */
  idemKey?: string | null;
}

export interface ApplyTxResult {
  txId: number;
  balanceAfter: Cents;
  duplicated: boolean;
}

export interface ReconcileResult {
  walletId: number;
  displayName: string;
  balanceCents: Cents;
  ledgerSumCents: Cents;
  diffCents: Cents;
  ok: boolean;
}

export class WalletService {
  constructor(private readonly db: Db) {}

  // ── 创建与查询 ───────────────────────────────────────────────

  create(input: CreateWalletInput): WalletRow {
    const initial = input.initialCents ?? 0;
    if (!Number.isInteger(initial) || initial < 0) {
      throw new PlaygroundError(
        'INTERNAL',
        `初始金额必须是非负整数（单位：分），收到 ${initial}`,
      );
    }
    return tx(this.db, () => {
      const res = run(
        this.db,
        `INSERT INTO wallets (owner_type, owner_id, display_name, balance_cents)
         VALUES (?, ?, ?, 0)`,
        input.ownerType,
        input.ownerId,
        input.displayName,
      );
      const id = Number(res.lastInsertRowid);
      if (initial > 0) {
        this.applyInner({
          walletId: id,
          kind: 'grant',
          deltaCents: initial,
          idemKey: `wallet:${id}:grant`,
        });
      }
      return this.getOrThrow(id);
    });
  }

  get(id: number): WalletRow | undefined {
    return one<WalletRow>(this.db, 'SELECT * FROM wallets WHERE id = ?', id);
  }

  getOrThrow(id: number): WalletRow {
    const w = this.get(id);
    if (!w) throw new PlaygroundError('WALLET_NOT_FOUND', `钱包不存在: ${id}`, 404);
    return w;
  }

  getByOwner(ownerType: WalletOwnerType, ownerId: string): WalletRow | undefined {
    return one<WalletRow>(
      this.db,
      'SELECT * FROM wallets WHERE owner_type = ? AND owner_id = ?',
      ownerType,
      ownerId,
    );
  }

  list(): WalletRow[] {
    return all<WalletRow>(
      this.db,
      `SELECT * FROM wallets
       WHERE owner_type IN ('agent','human')
       ORDER BY balance_cents DESC, id ASC`,
    );
  }

  transactions(walletId: number, limit = 50): TransactionRow[] {
    return all<TransactionRow>(
      this.db,
      `SELECT * FROM transactions WHERE wallet_id = ? ORDER BY id DESC LIMIT ?`,
      walletId,
      limit,
    );
  }

  // ── 唯一的余额变动入口 ───────────────────────────────────────

  apply(input: ApplyTxInput): ApplyTxResult {
    return tx(this.db, () => this.applyInner(input));
  }

  /** 假定调用方已经处在事务中（用于「建局 + 扣注」这类必须原子的复合操作） */
  applyInner(input: ApplyTxInput): ApplyTxResult {
    if (!Number.isInteger(input.deltaCents)) {
      throw new PlaygroundError(
        'INTERNAL',
        `金额必须是整数（单位：分），收到 ${input.deltaCents}`,
      );
    }
    if (input.deltaCents === 0) {
      throw new PlaygroundError('INTERNAL', '金额为 0 的流水没有意义');
    }

    // 幂等：同一个键只生效一次
    if (input.idemKey) {
      const existing = one<TransactionRow>(
        this.db,
        'SELECT * FROM transactions WHERE idem_key = ?',
        input.idemKey,
      );
      if (existing) {
        return {
          txId: existing.id,
          balanceAfter: existing.balance_after,
          duplicated: true,
        };
      }
    }

    const wallet = this.getOrThrow(input.walletId);
    const next = wallet.balance_cents + input.deltaCents;

    if (next < 0) {
      throw new PlaygroundError(
        'INSUFFICIENT_FUNDS',
        `余额不足：当前 ${wallet.balance_cents} 分，本次需要 ${-input.deltaCents} 分`,
        409,
      );
    }

    run(this.db, 'UPDATE wallets SET balance_cents = ? WHERE id = ?', next, input.walletId);

    const res = run(
      this.db,
      `INSERT INTO transactions (wallet_id, round_id, kind, delta_cents, balance_after, idem_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.walletId,
      input.roundId ?? null,
      input.kind,
      input.deltaCents,
      next,
      input.idemKey ?? null,
    );

    return { txId: Number(res.lastInsertRowid), balanceAfter: next, duplicated: false };
  }

  // ── 便捷方法 ─────────────────────────────────────────────────

  /** 发筹码 / 破产救济 */
  grant(walletId: number, cents: Cents, idemKey?: string): ApplyTxResult {
    return this.apply({
      walletId,
      kind: idemKey?.includes(':relief') ? 'relief' : 'grant',
      deltaCents: cents,
      idemKey,
    });
  }

  /** 两个钱包之间转账（用于对账测试、人工调整） */
  transfer(fromWalletId: number, toWalletId: number, cents: Cents, idemKey?: string): void {
    if (cents <= 0) throw new PlaygroundError('INTERNAL', '转账金额必须为正');
    tx(this.db, () => {
      this.applyInner({
        walletId: fromWalletId,
        kind: 'transfer',
        deltaCents: -cents,
        idemKey: idemKey ? `${idemKey}:out` : null,
      });
      this.applyInner({
        walletId: toWalletId,
        kind: 'transfer',
        deltaCents: cents,
        idemKey: idemKey ? `${idemKey}:in` : null,
      });
    });
  }

  // ── 对账自检 ─────────────────────────────────────────────────

  /**
   * 账本核对：流水累加必须恒等于钱包余额。
   * 这是整套系统的健康检查——只要有一个钱包对不上，就说明有人绕过了 apply()。
   */
  reconcile(walletId: number): ReconcileResult {
    const wallet = this.getOrThrow(walletId);
    const row = one<{ total: number | bigint | null }>(
      this.db,
      'SELECT SUM(delta_cents) AS total FROM transactions WHERE wallet_id = ?',
      walletId,
    );
    const ledgerSum = Number(row?.total ?? 0);
    const diff = wallet.balance_cents - ledgerSum;
    return {
      walletId,
      displayName: wallet.display_name,
      balanceCents: wallet.balance_cents,
      ledgerSumCents: ledgerSum,
      diffCents: diff,
      ok: diff === 0,
    };
  }

  reconcileAll(): ReconcileResult[] {
    return all<{ id: number }>(this.db, 'SELECT id FROM wallets ORDER BY id ASC').map((r) =>
      this.reconcile(r.id),
    );
  }
}
