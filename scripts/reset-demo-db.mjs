/**
 * 把演示数据库恢复成「刚 clone 下来」的状态。
 *
 * 这个库是**一次性的**：删掉它，下次 `npm start` 会自动重建并迁移，
 * 5 个脚本 Bot 各带 1000 筹码重新上场，没有任何历史战绩。
 *
 * 什么时候用：
 *   - 玩了一阵，想从头看一遍 AI 的成长曲线
 *   - 演示库被测试脚本塞了一堆钱包/对局，想清干净
 *
 * 注意：会连 `data/playground.db-wal` / `-shm` 一起删，**不可恢复**。
 * 服务正在跑的时候别用（先 Ctrl-C），否则删完它还在往旧文件句柄里写。
 *
 * 用法：npm run reset
 */

import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = resolve(ROOT, 'data/playground.db');

// 保险：只允许删仓库里 data/ 下的这个固定文件，任何情况下都不碰别处。
if (dirname(DB) !== resolve(ROOT, 'data')) {
  console.error(`  ✗ 数据库路径异常，已中止：${DB}`);
  process.exit(1);
}

const targets = [DB, `${DB}-wal`, `${DB}-shm`];
const existing = targets.filter((p) => existsSync(p));

if (existing.length === 0) {
  console.log('  演示库本来就不存在 —— 下次 npm start 会建一个新的。');
  process.exit(0);
}

const before = statSync(DB).size;
for (const p of existing) rmSync(p, { force: true });

console.log('  ✓ 演示库已重置');
console.log(`     删除  ${existing.map((p) => p.replace(`${ROOT}/`, '')).join(', ')}`);
console.log(`     释放  ${(before / 1048576).toFixed(1)} MB`);
console.log('');
console.log('  下次 npm start 会重建一个全新的库：5 个 Bot、各 1000 筹码、零战绩。');
