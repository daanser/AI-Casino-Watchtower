/**
 * 服务入口： npm run dev / npm start
 *
 * 默认**不放**脚本 Bot 上场 —— 起一个空场观察台，只等外部 agent（MCP / HTTP）接入。
 * 想开箱就有戏看，显式把 Bot 放上去：
 *   DEMO=1 npm run dev        # 5 个脚本 Bot 上场
 *   SPEED=0.25 npm run dev    # 五倍速
 */

import { createApp } from './app';
import { DEFAULT_DB_PATH } from '@ai-gaming/db';

const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? '127.0.0.1';
// 只有显式 DEMO=1 才放 Bot。默认关闭 —— 避免「清空演示库后重启，Bot 又自己长回来」。
const DEMO = process.env.DEMO === '1';
const SPEED = Number(process.env.SPEED ?? 1);

const bundle = createApp({ demo: DEMO, speed: SPEED });

await bundle.app.listen({ port: PORT, host: HOST });

// 定时器活不过重启。把还在飞的实时回合（大火箭）按剩余时间重新挂上，
// 否则那些局会永远卡在 awaiting_action —— 前端一直显示「飞行中」。
const resumed = bundle.rounds.resumeTimelines();

const games = bundle.rounds.registry.list().map((g) => g.meta.name).join(' · ');
const bots = bundle.runner.status();

console.log('');
console.log('  🔷 AI 游乐场已启动');
console.log(`     观察台   http://${HOST}:${PORT}/`);
console.log(`     接口     http://${HOST}:${PORT}/api/v1/state`);
console.log(`     WS       ws://${HOST}:${PORT}/ws`);
console.log(`     数据库   ${DEFAULT_DB_PATH}`);
console.log(`     游戏     ${games}`);
console.log(
  DEMO
    ? `     Bot      ${bots.map((b) => `${b.displayName}（${b.persona}）`).join(' · ')}`
    : '     Bot      未启用（默认关闭；需要时用 DEMO=1 开启）',
);
if (resumed > 0) console.log(`     接回     ${resumed} 局飞行中的大火箭`);
console.log('');
console.log('  纯虚拟筹码 · 不涉及任何真实货币 · 无充值、无提现、不可兑换');
console.log('');

const shutdown = async () => {
  console.log('\n  正在收摊…');
  await bundle.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
