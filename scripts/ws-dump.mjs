/** 连上观察台 WS，按 tableId 统计收到的帧 —— 排查「谁在给某张桌发帧」。 */
import { WebSocket } from 'ws';

const URL = process.argv[2] ?? 'ws://127.0.0.1:5173/ws';
const MS = Number(process.argv[3] ?? 8000);

const byTable = new Map();
const ws = new WebSocket(URL);
ws.on('message', (raw) => {
  const f = JSON.parse(String(raw));
  const key = f.tableId ?? `(${f.type})`;
  const rec = byTable.get(key) ?? { n: 0, types: new Set() };
  rec.n += 1;
  rec.types.add(f.type);
  byTable.set(key, rec);
});
setTimeout(() => {
  for (const [k, v] of byTable) console.log(k.padEnd(18), String(v.n).padStart(4), [...v.types].join(','));
  ws.close();
  process.exit(0);
}, MS);
