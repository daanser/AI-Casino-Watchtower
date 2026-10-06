/**
 * @ai-gaming/db —— SQLite 连接、迁移、事务
 *
 * 用 Node 22 内置的 node:sqlite，零原生依赖（不需要编译 better-sqlite3）。
 * 注意：node:sqlite 是**同步** API。配合 Node 单线程，一个事务块天然不会被
 * 其他事务插进来——这正是我们敢把钱包写成「同步事务 + 幂等键」的底气。
 * 但为了未来可能出现 await 的临界区，钱包层仍然加了显式互斥锁（见 core/wallet.ts）。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(HERE, '..', 'migrations');

export const DEFAULT_DB_PATH =
  process.env.PLAYGROUND_DB ?? resolve(process.cwd(), 'data', 'playground.db');

export type Db = DatabaseSync;

/** 打开数据库：自动建目录，开 WAL、外键、busy_timeout。 */
export function openDb(path: string = DEFAULT_DB_PATH): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

// ─────────────────────────────────────────────────────────────
// 迁移
// ─────────────────────────────────────────────────────────────

export function migrate(db: Db, dir: string = MIGRATIONS_DIR): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  if (!existsSync(dir)) throw new Error(`迁移目录不存在: ${dir}`);

  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name),
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
      db.exec('COMMIT');
      done.push(file);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${file} 失败: ${(err as Error).message}`);
    }
  }
  return done;
}

// ─────────────────────────────────────────────────────────────
// 事务（带嵌套保护）
// ─────────────────────────────────────────────────────────────

const txDepth = new WeakMap<Db, number>();

/**
 * 在 BEGIN IMMEDIATE 事务里执行 fn。
 * 嵌套调用会复用外层事务（SQLite 不支持真正的嵌套事务，嵌套 BEGIN 会报错）。
 */
export function tx<T>(db: Db, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  if (depth > 0) {
    // 已在事务中，直接执行，由最外层统一提交
    txDepth.set(db, depth + 1);
    try {
      return fn();
    } finally {
      txDepth.set(db, depth);
    }
  }

  db.exec('BEGIN IMMEDIATE');
  txDepth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw err;
  } finally {
    txDepth.set(db, 0);
  }
}

// ─────────────────────────────────────────────────────────────
// 查询小工具
// ─────────────────────────────────────────────────────────────

export function one<T>(db: Db, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function all<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function run(db: Db, sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...(params as never[]));
}
