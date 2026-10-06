/**
 * 服务入口： npm run dev / npm start
 *
 * 默认会放脚本 Bot 上场，所以打开页面立刻就有牌局在看。
 * 关掉： DEMO=0 npm run dev
 * 加速： SPEED=0.25 npm run dev
 */

import { createApp } from './app';
import { DEFAULT_DB_PATH } from '@ai-gaming/db';

const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? '127.0.0.1';
const DEMO = process.env.DEMO !== '0';
const SPEED = Number(process.env.SPEED ?? 1);

const bundle = createApp({ demo: DEMO, speed: SPEED });

await bundle.app.listen({ port: PORT, host: HOST });

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
    : '     Bot      未启用（DEMO=0）',
);
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
