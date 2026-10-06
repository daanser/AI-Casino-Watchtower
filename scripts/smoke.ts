/**
 * 端到端冒烟验证
 *
 * 走真实 HTTP + WebSocket，把整条链路跑一遍：
 *   建钱包 → 并行开三桌 → 下注 → 提交动作（带「我为什么这么打」）→ 结算
 *   → 账本对账 → 公平性复算 → 确认前端能收到实时事件
 *
 * 运行： npm run smoke
 */

import { WebSocket } from 'ws';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createApp } from '../apps/server/src/app';
import { coins, fmtCoins, type ServerFrame } from '@ai-gaming/shared';
import { verifyCommit } from '@ai-gaming/core';

const PORT = Number(process.env.SMOKE_PORT ?? 5199);
const DB_PATH = join(tmpdir(), `ai-gaming-smoke-${Date.now()}.db`);

const ok = (s: string) => console.log(`  \u2713 ${s}`);
const step = (s: string) => console.log(`\n${s}`);
const money = (c: number) => `${fmtCoins(c)} 筹码`;

let failures = 0;
function check(cond: boolean, label: string, detail = '') {
  if (cond) {
    ok(label);
  } else {
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
// 注意：监听器必须在 open 之前挂上，否则服务端在连接瞬间发来的 hello 帧会丢
ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as ServerFrame));
await new Promise<void>((resolve, reject) => {
  ws.once('open', () => resolve());
  ws.once('error', reject);
});

console.log('');
console.log('  AI 游乐场 · 端到端冒烟验证');
console.log('  ' + '─'.repeat(52));

// ── 1. 三个 AI 选手各开一个钱包 ──────────────────────────────
step('1. 建三个 AI 选手，各发 1000 筹码');

const BOTS = [
  { id: 'bot-alpha', name: '阿尔法', bet: 'red', table: 'roulette-1', why: '红色连续 5 局没出，我赌它该回来了' },
  { id: 'bot-beta', name: '贝塔', bet: 'black', table: 'roulette-2', why: '黑格占 18/37，长期期望略优，我按数学来' },
  { id: 'bot-gamma', name: '伽马', bet: 'straight:17', table: 'roulette-3', why: '押单号赔 36 倍，小注博大，输了不心疼' },
];

for (const bot of BOTS) {
  await api('POST', '/wallets', {
    ownerType: 'agent',
    ownerId: bot.id,
    displayName: bot.name,
    initialCents: coins(1000),
  });
}

const wallets = await api<Array<{ id: number; owner_id: string; display_name: string; balance_cents: number }>>(
  'GET',
  '/wallets',
);
check(wallets.length === 3, `建好 ${wallets.length} 个钱包`);
for (const w of wallets) check(w.balance_cents === coins(1000), `${w.display_name} 初始 ${money(w.balance_cents)}`);

// ── 2. 三桌并行开打 ──────────────────────────────────────────
step('2. 三桌并行开打（每桌 6 局，互不阻塞）');

const ROUNDS_PER_BOT = 6;
const startedAt = Date.now();

async function playOne(bot: (typeof BOTS)[number], walletId: number, i: number) {
  const round = await api<{ id: number; status: string; view: Record<string, unknown> }>(
    'POST',
    '/rounds',
    {
      walletId,
      gameId: 'roulette',
      betCents: coins(10),
      params: { bet: bot.bet },
      tableId: bot.table,
      actor: bot.id,
    },
  );

  // 关键：开局后局面里**没有**中奖号码
  if ('winning' in round.view) throw new Error('泄漏！开局局面里出现了中奖号码');

  const result = await api<{ round: { status: string; netCents: number; serverSeed: string | null }; balanceAfter: number }>(
    'POST',
    `/rounds/${round.id}/action`,
    {
      action: { type: 'spin' },
      reasoning: `${bot.why}（第 ${i + 1} 局）`,
      actor: bot.id,
    },
  );
  return result;
}

const all = await Promise.all(
  BOTS.flatMap((bot, bi) => {
    const walletId = wallets.find((w) => w.owner_id === bot.id)!.id;
    return Array.from({ length: ROUNDS_PER_BOT }, (_, i) => playOne(bot, walletId, i));
  }),
);

const elapsed = Date.now() - startedAt;
check(all.length === BOTS.length * ROUNDS_PER_BOT, `${all.length} 局全部结算完毕`);
check(
  all.every((r) => r.round.status === 'settled'),
  '每局状态都是 settled',
);
check(all.every((r) => r.round.serverSeed !== null), '结算后种子已揭示');
console.log(`    耗时 ${elapsed}ms（三桌并行）`);

// ── 3. 账本对账 ──────────────────────────────────────────────
step('3. 账本对账：流水累加是否恒等于余额');

const rec = await api<{ ok: boolean; checked: number; results: Array<{ displayName: string; balanceCents: number; ledgerSumCents: number; ok: boolean }> }>(
  'GET',
  '/reconcile',
);
for (const r of rec.results) {
  check(r.ok, `${r.displayName}：余额 ${money(r.balanceCents)} = 流水 ${money(r.ledgerSumCents)}`);
}
check(rec.ok, `全部 ${rec.checked} 个钱包账本一致`);

// ── 4. 公平性复算 ────────────────────────────────────────────
step('4. 公平性：复算公布的种子是否对应开局时那个承诺');

const roundIds = await api<Array<{ id: number }>>('GET', '/rounds?limit=3');
const verifications: Array<{ ok: boolean; commit: string; serverSeed: string; clientSeed: string; nonce: number }> = [];
for (const r of roundIds) {
  verifications.push(await api('GET', `/rounds/${r.id}/verify`));
}
check(
  verifications.every((v) => v.ok),
  `${verifications.filter((v) => v.ok).length}/${roundIds.length} 局哈希复算通过`,
);

// 篡改检测：把揭示的种子改一个字符，验签必须立刻失败
const v0 = verifications[0]!;
const tamperedSeed = v0.serverSeed.slice(0, -1) + (v0.serverSeed.endsWith('0') ? '1' : '0');
check(verifyCommit(v0.serverSeed, v0.commit), '原始种子验签通过');
check(!verifyCommit(tamperedSeed, v0.commit), '种子改一个字符后验签立即失败');
check(v0.clientSeed.length > 0 && v0.nonce > 0, `种子三要素齐全（clientSeed=${v0.clientSeed} nonce=${v0.nonce}）`);

// ── 5. 前端能看到什么 ────────────────────────────────────────
step('5. WebSocket 实时事件（前端多屏观察台的数据来源）');

await new Promise((r) => setTimeout(r, 150));
const kinds = new Map<string, number>();
for (const f of frames) kinds.set(f.type, (kinds.get(f.type) ?? 0) + 1);
for (const [k, v] of [...kinds.entries()].sort()) console.log(`    ${k.padEnd(16)} × ${v}`);

check((kinds.get('hello') ?? 0) === 1, '握手帧已收到');
check((kinds.get('round_started') ?? 0) === all.length, '每局都有 round_started');
check((kinds.get('round_settled') ?? 0) === all.length, '每局都有 round_settled');
check((kinds.get('wallet_update') ?? 0) >= all.length, '余额变动已推送');
check((kinds.get('reasoning') ?? 0) === all.length, '「我为什么这么打」全部推送');

const reasoningFrames = frames.filter((f) => f.type === 'reasoning') as Array<{ text: string; actor: string }>;
check(reasoningFrames.length > 0, '随机抽一条 AI 自述：');
if (reasoningFrames[0]) console.log(`    ${reasoningFrames[0].actor}：「${reasoningFrames[0].text}」`);

// 事件帧里绝不能出现中奖号码之外的隐藏信息
const leaked = frames.filter(
  (f) => f.type === 'round_event' && f.eventType === 'bet_placed' && 'winning' in (f.payload ?? {}),
);
check(leaked.length === 0, '未发现隐藏信息泄漏');

// ── 6. 排行 ──────────────────────────────────────────────────
step('6. 当前战绩');
const finalWallets = await api<Array<{ display_name: string; balance_cents: number }>>('GET', '/wallets');
for (const w of finalWallets.sort((a, b) => b.balance_cents - a.balance_cents)) {
  const delta = w.balance_cents - coins(1000);
  const sign = delta >= 0 ? '+' : '';
  console.log(`    ${w.display_name.padEnd(8)} ${money(w.balance_cents).padStart(14)}  (${sign}${fmtCoins(delta)})`);
}

// ── 收尾 ─────────────────────────────────────────────────────
ws.close();
await bundle.close();
for (const suffix of ['', '-wal', '-shm']) {
  try {
    rmSync(DB_PATH + suffix, { force: true });
  } catch {
    /* 忽略 */
  }
}

console.log('\n  ' + '─'.repeat(52));
if (failures === 0) {
  console.log('  ✓ 全部通过：账本一致、种子可验、事件已推送、无隐藏信息泄漏');
  console.log('  P0 骨架跑通了。');
  process.exit(0);
} else {
  console.log(`  ✗ ${failures} 项失败`);
  process.exit(1);
}
