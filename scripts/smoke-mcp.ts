/**
 * MCP 冒烟测试 —— 用官方 MCP Client 通过 stdio 连上我们自己的 MCP Server，
 * 完整走一遍「发现工具 → 开户 → 下注 → 结算 → 验算公平性 → 围观」的链路。
 *
 * **自带进程内主服务 + 临时数据库**（与 smoke-games.ts 同一套路），
 * 所以不需要预先 `npm start`，也不会往演示库里塞测试钱包和对局。
 *
 * 想故意打线上库时：`PG_API_URL=http://127.0.0.1:5173 npm run smoke:mcp`
 * —— 但那样会留下一个「MCP 冒烟测试员」钱包，别在要给人看的库里这么干。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createApp } from '../apps/server/src/app';

const PORT = Number(process.env.SMOKE_MCP_PORT ?? 5398);
const DB_PATH = join(tmpdir(), `ai-gaming-smoke-mcp-${Date.now()}.db`);

// 自带一个隔离的主服务：冒烟测试绝不该写进演示库。
const bundle = createApp({ dbPath: DB_PATH });
await bundle.app.listen({ port: PORT, host: '127.0.0.1' });

const API_URL = process.env.PG_API_URL ?? `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 把工具返回的 JSON 文本解析回对象 */
function parseTool(res: unknown): Record<string, unknown> {
  const content = (res as { content?: { type: string; text: string }[] }).content ?? [];
  const first = content.find((c) => c.type === 'text');
  if (!first) throw new Error('工具没有返回文本内容');
  return JSON.parse(first.text) as Record<string, unknown>;
}

function rawText(res: unknown): string {
  const content = (res as { content?: { type: string; text: string }[] }).content ?? [];
  return content.find((c) => c.type === 'text')?.text ?? '';
}

function isError(res: unknown): boolean {
  return Boolean((res as { isError?: boolean }).isError);
}

async function main(): Promise<void> {
  console.log('\n🧪 MCP 冒烟测试\n');
  console.log(`   上游主服务: ${API_URL}\n`);

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'apps/mcp/src/index.ts'],
    env: { ...process.env, PG_API_URL: API_URL },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'smoke-mcp', version: '0.1.0' });

  // 把 MCP Server 的 stderr 转出来，方便排错（注意不能吞掉）
  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`     [mcp] ${line}`);
    });
  }

  await client.connect(transport);

  // ── 1. 工具发现 ──────────────────────────────────────────────
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  console.log(`  📋 发现 ${names.length} 个工具：${names.join(', ')}\n`);
  check('工具数量 ≥ 15', names.length >= 15, `实际 ${names.length}`);
  for (const required of [
    'pg_help',
    'pg_list_games',
    'pg_list_wallets',
    'pg_create_wallet',
    'pg_start_round',
    'pg_act',
    'pg_quick_bet',
    'pg_get_round',
    'pg_verify_round',
    'pg_leaderboard',
    'pg_watch',
    'pg_reconcile',
  ]) {
    check(`存在工具 ${required}`, names.includes(required));
  }

  // ── 2. pg_help ───────────────────────────────────────────────
  const help = await client.callTool({ name: 'pg_help', arguments: {} });
  const helpText = rawText(help);
  check('pg_help 返回玩法总览', helpText.includes('推荐调用顺序'), `${helpText.length} 字符`);
  check('pg_help 提到 reasoning 机制', helpText.includes('我为什么这么打'));

  // ── 3. pg_list_games ─────────────────────────────────────────
  const games = await client.callTool({ name: 'pg_list_games', arguments: {} });
  const gameList = JSON.parse(rawText(games)) as { id: string }[];
  check('pg_list_games 覆盖全部 14 款游戏', gameList.length >= 14, gameList.map((g) => g.id).join(','));
  const NEW_GAMES = ['baccarat', 'sicbo', 'holdem', 'video-poker', 'wheel', 'plinko', 'craps', 'keno', 'hi-lo'];
  const absent = NEW_GAMES.filter((id) => !gameList.some((g) => g.id === id));
  check('新增的 9 款游戏都已在册', absent.length === 0, absent.length ? `缺少 ${absent.join(',')}` : NEW_GAMES.join(','));

  // ── 4. 开一个专属钱包（避免和脚本 Bot 抢钱）─────────────────
  // owner_id 固定为 mcp-smoke：临时库用完即删，重复跑也不会堆出一排测试钱包。
  const ownerId = 'mcp-smoke';
  const created = await client.callTool({
    name: 'pg_create_wallet',
    arguments: { owner_id: ownerId, display_name: 'MCP 冒烟测试员', initial_coins: 500 },
  });
  const wallet = parseTool(created) as { id: number; balanceCoins: string };
  check('pg_create_wallet 成功开户', typeof wallet.id === 'number', `钱包 #${wallet.id}，余额 ${wallet.balanceCoins}`);
  const walletId = wallet.id;

  // ── 5. pg_quick_bet：轮盘押红，一步结算 ─────────────────────
  const bet = await client.callTool({
    name: 'pg_quick_bet',
    arguments: {
      wallet_id: walletId,
      game_id: 'roulette',
      bet_coins: 1,
      params: { bet: 'red' },
      reasoning: '冒烟测试：押红，纯粹为了验证链路通不通',
    },
  });
  check('pg_quick_bet 未报错', !isError(bet), isError(bet) ? rawText(bet) : '');
  const betResult = parseTool(bet) as {
    roundId: number;
    payoutCoins: string;
    netCoins: string;
    balanceCoins: string;
    view: Record<string, unknown>;
  };
  check('pg_quick_bet 返回 roundId', typeof betResult.roundId === 'number', `第 ${betResult.roundId} 局`);
  check('pg_quick_bet 已结算（有开奖号码）', typeof betResult.view?.winning === 'number', `开出 ${betResult.view?.winning}`);

  // ── 6. 公平性验算 ────────────────────────────────────────────
  const verify = await client.callTool({
    name: 'pg_verify_round',
    arguments: { round_id: betResult.roundId },
  });
  const v = parseTool(verify) as { ok: boolean };
  check('pg_verify_round 种子验算通过', v.ok === true);

  // ── 7. 事件流里能找到我们的 reasoning ───────────────────────
  const events = await client.callTool({
    name: 'pg_round_events',
    arguments: { round_id: betResult.roundId },
  });
  const evList = JSON.parse(rawText(events)) as { type: string; payload: { text?: string } }[];
  const reasoningEv = evList.find((e) => e.type === 'reasoning');
  check(
    'reasoning 已落库（「我为什么这么打」）',
    Boolean(reasoningEv?.payload?.text?.includes('冒烟测试')),
    reasoningEv?.payload?.text ?? '(没找到)',
  );

  // ── 8. 黑杰克多步决策 ────────────────────────────────────────
  const bjStart = await client.callTool({
    name: 'pg_start_round',
    arguments: { wallet_id: walletId, game_id: 'blackjack', bet_coins: 2 },
  });
  const bjRound = parseTool(bjStart) as { roundId: number; status: string; view: Record<string, unknown> };
  check('pg_start_round 开了黑杰克', typeof bjRound.roundId === 'number', `第 ${bjRound.roundId} 局，状态 ${bjRound.status}`);

  let bjRoundId = bjRound.roundId;
  let bjDone = bjRound.status === 'settled';
  let steps = 0;
  while (!bjDone && steps < 8) {
    steps += 1;
    const act = await client.callTool({
      name: 'pg_act',
      arguments: {
        round_id: bjRoundId,
        action_type: 'stand',
        reasoning: `冒烟测试第 ${steps} 步：直接停牌`,
      },
    });
    check(`pg_act(stand) 第 ${steps} 步未报错`, !isError(act), isError(act) ? rawText(act) : '');
    const ar = parseTool(act) as { settled: boolean };
    bjDone = ar.settled;
  }
  check('黑杰克通过 pg_act 走到结算', bjDone, `用了 ${steps} 步`);

  // ── 8b. 新游戏也能通过 MCP 玩通：骰宝押「大」─────────────────
  const sicboStart = await client.callTool({
    name: 'pg_start_round',
    arguments: {
      wallet_id: walletId,
      game_id: 'sicbo',
      bet_coins: 1,
      params: { bet: 'big' },
      reasoning: '冒烟测试：换一款新游戏，押大',
    },
  });
  const sicboRound = parseTool(sicboStart) as { roundId: number; status: string; view: Record<string, unknown> };
  check('pg_start_round 开了骰宝', typeof sicboRound.roundId === 'number', `第 ${sicboRound.roundId} 局`);
  check(
    '骰宝开局没泄漏骰子点数',
    !('dice' in (sicboRound.view ?? {})),
    JSON.stringify(sicboRound.view),
  );

  const sicboAct = await client.callTool({
    name: 'pg_act',
    arguments: { round_id: sicboRound.roundId, action_type: 'roll', reasoning: '冒烟测试：掷骰' },
  });
  const sicboDone = parseTool(sicboAct) as { settled: boolean; view?: Record<string, unknown> };
  check(
    '骰宝通过 pg_act 一步结算',
    sicboDone.settled === true,
    `开出 ${JSON.stringify(sicboDone.view?.dice ?? '?')}`,
  );

  // ── 8c. action_params 透传：视频扑克换牌位置 ─────────────────
  const vpStart = await client.callTool({
    name: 'pg_start_round',
    arguments: { wallet_id: walletId, game_id: 'video-poker', bet_coins: 1 },
  });
  const vpRound = parseTool(vpStart) as { roundId: number; status: string };
  const vpAct = await client.callTool({
    name: 'pg_act',
    arguments: {
      round_id: vpRound.roundId,
      action_type: 'draw',
      action_params: { hold: [0, 2, 4] },
      reasoning: '冒烟测试：保留第 1/3/5 张',
    },
  });
  const vpDone = parseTool(vpAct) as { settled: boolean; view?: Record<string, unknown> };
  const vpHeld = vpDone.view?.held as number[] | undefined;
  check('pg_act 的 action_params 透传到视频扑克', vpDone.settled === true, `held=${JSON.stringify(vpHeld)}`);
  check(
    '视频扑克确实按 hold=[0,2,4] 换牌',
    Array.isArray(vpHeld) && vpHeld.length === 3 && [0, 2, 4].every((i) => vpHeld.includes(i)),
    JSON.stringify(vpHeld),
  );

  // ── 9. 排行榜 & 对账 ─────────────────────────────────────────
  const lb = await client.callTool({ name: 'pg_leaderboard', arguments: {} });
  const board = parseTool(lb) as { leaderboard: { walletId: number }[] };
  check(
    'pg_leaderboard 含我们的钱包',
    board.leaderboard.some((x) => x.walletId === walletId),
    `${board.leaderboard.length} 个钱包上榜`,
  );

  const rec = await client.callTool({ name: 'pg_reconcile', arguments: {} });
  const recData = parseTool(rec) as { ok: boolean; checked: number };
  check('pg_reconcile 账本平衡', recData.ok === true, `检查了 ${recData.checked} 个钱包`);

  // ── 10. pg_watch 围观实时帧 ─────────────────────────────────
  const watch = await client.callTool({
    name: 'pg_watch',
    arguments: { seconds: 2 },
  });
  const w = parseTool(watch) as { frameCount: number; byType: Record<string, number> };
  check(
    'pg_watch 抓到实时帧',
    w.frameCount > 0,
    `${w.frameCount} 帧：${JSON.stringify(w.byType)}`,
  );

  // ── 11. 错误处理：注额越界应被优雅拒绝 ───────────────────────
  const badBet = await client.callTool({
    name: 'pg_quick_bet',
    arguments: { wallet_id: walletId, game_id: 'roulette', bet_coins: 999999, params: { bet: 'red' } },
  });
  check('注额越界被拒绝且不崩溃', isError(badBet), rawText(badBet).slice(0, 60));

  // ── 12. 错误处理：不存在的局 ─────────────────────────────────
  const badRound = await client.callTool({
    name: 'pg_get_round',
    arguments: { round_id: 99999999 },
  });
  check('查不存在的局被优雅拒绝', isError(badRound), rawText(badRound).slice(0, 60));

  await client.close();
  await bundle.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(DB_PATH + suffix, { force: true });
    } catch {
      /* 忽略：临时库清不掉不影响结论 */
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  通过 ${pass} / ${pass + fail}`);
  console.log(`${'─'.repeat(50)}\n`);

  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\n冒烟测试崩了:', err);
  process.exit(1);
});
