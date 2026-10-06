/**
 * 全游戏端到端冒烟验证
 *
 * 走真实 HTTP + WebSocket，验证三件事：
 *   A. 14 款游戏每一款都能「开局 → 驱动动作 → 结算 → 种子揭示」，且开局不泄漏隐藏信息；
 *   B. 五个脚本 Bot 的槽位（tableId）在整轮运行中固定不变；
 *   C. Bot 自主切换游戏时会广播 game_switch 帧，且带明确的中文切换理由。
 *
 * 自带一个进程内主服务，不依赖 npm start，跑完即清理。
 *
 * 运行： npm run smoke:games
 */

import { WebSocket } from 'ws';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createApp } from '../apps/server/src/app';
import { actOtherGame, openOtherGame, SCRIPTED_BOTS, type ScriptedBot } from '@ai-gaming/agents';
import { coins, fmtCoins, GAME_IDS, type GameId, type ServerFrame } from '@ai-gaming/shared';

const PORT = Number(process.env.SMOKE_GAMES_PORT ?? 5399);
const DB_PATH = join(tmpdir(), `ai-gaming-smoke-games-${Date.now()}.db`);

const ok = (s: string) => console.log(`  \u2713 ${s}`);
const step = (s: string) => console.log(`\n${s}`);

let failures = 0;
function check(cond: boolean, label: string, detail = '') {
  if (cond) ok(label);
  else {
    failures++;
    console.log(`  \u2717 ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const bundle = createApp({ dbPath: DB_PATH });
await bundle.app.listen({ port: PORT, host: '127.0.0.1' });
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return json as T;
}

// ── 接上 WebSocket，假装自己是前端观察台 ──────────────────────
const frames: ServerFrame[] = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as ServerFrame));
await new Promise<void>((resolve, reject) => {
  ws.once('open', () => resolve());
  ws.once('error', reject);
});

console.log('');
console.log('  AI 游乐场 · 全游戏端到端冒烟验证');
console.log('  ' + '─'.repeat(52));

// ── 0. 游戏注册表 ─────────────────────────────────────────────
step('0. 游戏注册表');
const games = await api<Array<{ id: string; name: string; actions: string[]; pacing: string }>>('GET', '/games');
check(games.length === GAME_IDS.length, `注册了 ${games.length} 款游戏（期望 ${GAME_IDS.length}）`);
const missing = GAME_IDS.filter((g) => !games.some((x) => x.id === g));
check(missing.length === 0, '14 款游戏 id 与共享常量完全对齐', missing.join(','));
for (const g of games) {
  check(g.actions.length > 0, `${g.name.padEnd(12)} 至少有一个可执行动作 [${g.actions.join('/')}] pacing=${g.pacing}`);
}

// ── 1. 逐款游戏跑通一局 ───────────────────────────────────────
step('1. 14 款游戏各跑一局：开局 → 驱动动作 → 结算 → 揭示种子');

/** 开局阶段绝不允许出现的隐藏字段（一旦出现就是泄漏） */
const HIDDEN_AT_OPEN: Record<GameId, string[]> = {
  slots: ['reels'],
  roulette: ['winning'],
  crash: ['crashPoint', 'multiplier'],
  blackjack: ['dealerTotal'],
  baccarat: ['player', 'banker'],
  sicbo: ['dice'],
  holdem: ['dealer'],
  'video-poker': ['handName'],
  'dragon-tiger': ['dragon', 'tiger', 'winner'],
  wheel: ['landedIndex'],
  plinko: ['path', 'slot'],
  craps: [],
  keno: ['drawn', 'hits'],
  'hi-lo': ['nextCard'],
};

const wallet = await api<{ id: number }>('POST', '/wallets', {
  ownerType: 'agent',
  ownerId: 'smoke-games',
  displayName: '全游戏冒烟',
  initialCents: coins(100000),
});

const driver: ScriptedBot = SCRIPTED_BOTS[0]!;
const ctx = { balanceCents: coins(100000), recentNet: [] as number[], minBetCents: coins(1), roundIndex: 0 };

interface GameOutcome { gameId: string; steps: number; netCents: number; seeded: boolean; }
const outcomes: GameOutcome[] = [];

for (const gameId of GAME_IDS) {
  const open = openOtherGame(driver, gameId, ctx);
  const round = await api<{ id: number; status: string; view: Record<string, unknown> }>('POST', '/rounds', {
    walletId: wallet.id,
    gameId,
    betCents: Math.max(coins(1), Math.min(open.betCents, coins(10))),
    params: open.params,
    tableId: `smoke-${gameId}`,
    actor: 'smoke-games',
    reasoning: `冒烟：${gameId} 开局`,
  });

  // 开局不得泄漏隐藏信息
  const leaked = HIDDEN_AT_OPEN[gameId].filter((k) => k in round.view && round.view[k] !== null);
  check(leaked.length === 0, `${gameId.padEnd(12)} 开局无隐藏信息泄漏`, leaked.join(','));

  // 黑杰克暗牌：revealed 之前庄家只应看到一张
  if (gameId === 'blackjack') {
    const dealer = round.view.dealer as unknown[] | undefined;
    check(Array.isArray(dealer) && dealer.length === 1, 'blackjack    开局庄家只亮一张（暗牌已藏）');
  }
  // 视频扑克：结算字段开局必须是 null
  if (gameId === 'video-poker') {
    check(round.view.handName === null && round.view.multiplier === null, 'video-poker  开局赔率字段为 null');
  }

  let current = round;
  let steps = 0;
  while (current.status === 'awaiting_action' && steps < 64) {
    steps += 1;
    const decision = actOtherGame(driver, gameId, current.view, { ...ctx, roundIndex: steps });
    const res = await api<{ round: { status: string; netCents: number; serverSeed: string | null }; balanceAfter: number }>(
      'POST',
      `/rounds/${current.id}/action`,
      { action: decision.action, reasoning: decision.reasoning || undefined, actor: 'smoke-games' },
    );
    current = res.round as unknown as typeof current;
  }

  const settled = current.status === 'settled';
  check(settled, `${gameId.padEnd(12)} 已结算（用了 ${steps} 步）`);
  const seeded = (current as unknown as { serverSeed: string | null }).serverSeed !== null;
  check(seeded, `${gameId.padEnd(12)} 结算后已揭示服务器种子`);
  outcomes.push({ gameId, steps, netCents: (current as unknown as { netCents: number }).netCents, seeded });
}

// ── 2. 账本对账 ──────────────────────────────────────────────
step('2. 账本对账');
const rec = await api<{ ok: boolean; checked: number }>('GET', '/reconcile');
check(rec.ok, `${rec.checked} 个钱包账本全部平衡`);

// ── 3. 五个 Bot 槽位固定 + 自主切换广播 ───────────────────────
step('3. 五个 Bot 自主选游戏，槽位固定不变');

const slots = SCRIPTED_BOTS.map((b) => b.tableId);
check(new Set(slots).size === slots.length, `五个槽位互不重复：${slots.join(' / ')}`);

// 加速跑一段，观察切换行为
bundle.runner.start();
await new Promise((r) => setTimeout(r, 14000));
const status = bundle.runner.status();
bundle.runner.stop();

check(status.length === SCRIPTED_BOTS.length, `${status.length} 个 Bot 在跑`);
for (const b of status) {
  check(slots.includes(b.tableId), `${b.displayName} 槽位固定为 ${b.tableId}（已玩 ${b.rounds} 局，净 ${fmtCoins(b.netCents)}）`);
}

await new Promise((r) => setTimeout(r, 300));
const switches = frames.filter((f) => f.type === 'game_switch') as Array<{
  botId: string; displayName: string; tableId: string; fromGameId: string; toGameId: string; reason: string;
}>;
check(switches.length > 0, `收到了 ${switches.length} 次「换游戏」广播`);

if (switches.length > 0) {
  const s = switches[0]!;
  console.log(`    示例：${s.displayName} 从「${s.fromGameId}」切到「${s.toGameId}」`);
  console.log(`          理由：${s.reason}`);
  check(Boolean(s.reason && s.reason.length >= 10), '切换理由是一段说得通的中文，而不是空字符串');
  check(s.fromGameId !== s.toGameId, '切换前后确实是两款不同的游戏');
  check(GAME_IDS.includes(s.toGameId as GameId), `目标游戏 ${s.toGameId} 是合法游戏`);
}

// 同一个 Bot 的所有切换帧，tableId 必须完全一致（位置绝不跳动）
const byBot = new Map<string, Set<string>>();
for (const s of switches) {
  if (!byBot.has(s.botId)) byBot.set(s.botId, new Set());
  byBot.get(s.botId)!.add(s.tableId);
}
const wobbly = [...byBot.entries()].filter(([, set]) => set.size > 1);
check(wobbly.length === 0, '换游戏不会改变任何 Bot 的槽位（前端位置固定）', JSON.stringify(wobbly));

// ── 4. 前端能收到什么 ────────────────────────────────────────
step('4. WebSocket 实时事件统计');
const kinds = new Map<string, number>();
for (const f of frames) kinds.set(f.type, (kinds.get(f.type) ?? 0) + 1);
for (const [k, v] of [...kinds.entries()].sort()) console.log(`    ${k.padEnd(16)} × ${v}`);
check((kinds.get('game_switch') ?? 0) > 0, '前端会收到 game_switch 帧（可据此弹出「自主切换」提示）');
check((kinds.get('round_settled') ?? 0) >= GAME_IDS.length, '每款游戏都推了 round_settled');

// ── 收尾 ─────────────────────────────────────────────────────
ws.close();
await bundle.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { rmSync(DB_PATH + suffix, { force: true }); } catch { /* 忽略 */ }
}

console.log('\n  ' + '─'.repeat(52));
if (failures === 0) {
  console.log('  ✓ 全部通过：14 款游戏都能玩通、Bot 槽位固定、换游戏有明确理由');
  process.exit(0);
} else {
  console.log(`  ✗ ${failures} 项失败`);
  process.exit(1);
}
