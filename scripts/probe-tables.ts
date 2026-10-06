/**
 * 用**真实的** /api/v1/state 快照跑一遍前端 reducer，看它会渲染出几个桌位。
 *
 * 用途：排查「观察台上出现了不该出现的桌位」。浏览器里不好断点，直接喂快照更快。
 * 用法：npx tsx scripts/probe-tables.ts [apiBase]
 */
import { initialState, reducer, type State } from '../apps/web/src/lib/reducer';
import type { PlaygroundSnapshot } from '../apps/web/src/lib/types';

const base = process.argv[2] ?? 'http://127.0.0.1:5173';
const snap = (await (await fetch(`${base}/api/v1/state`)).json()) as PlaygroundSnapshot;

const s: State = reducer(initialState, { type: 'snapshot', snapshot: snap });

console.log(`Bot 槽位   : ${snap.bots.map((b) => b.tableId).join(', ')}`);
console.log(`快照 table 行: ${snap.tables.length}（按 桌号×游戏 分组的历史统计）`);
console.log(`reducer 产出 : ${Object.keys(s.tables).length} 个桌位`);
for (const t of Object.values(s.tables)) {
  console.log(`   - ${t.tableId.padEnd(16)} ${t.gameId.padEnd(14)} status=${t.status}`);
}
