/**
 * 观察台状态机的单元测试。
 *
 * 这里覆盖的是「一帧广播 → 画面上应该显示什么」的映射关系 —— 每个游戏的
 * 事件序列都不一样，是前端最容易出错的地方，而且用浏览器很难稳定复现。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, initialState, MAX_FEED, reducer, type State } from '../src/lib/reducer';
import type { MetaFrame, PlaygroundSnapshot, TableSummary } from '../src/lib/types';

let uid = 0;
/** 造一帧广播，自动补上前端自己贴的元数据 */
function frame(f: Record<string, unknown>): MetaFrame {
  uid += 1;
  return { ...f, _uid: `t${uid}`, _at: 1_000_000 + uid } as MetaFrame;
}

/**
 * 造一个「多少毫秒以前」的时间戳，格式与后端一致。
 *
 * 后端的 lastActivity 是 SQLite 的 UTC 文本（"2026-10-06 09:28:57"），
 * 不能直接塞 ISO 字符串 —— reducer 会补 T/Z 再解析，塞 ISO 会变成非法时间。
 */
const utcAgo = (msAgo: number) =>
  new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');

const started = (gameId: string, view: Record<string, unknown> = {}, roundId = 1) =>
  frame({
    type: 'round_started',
    roundId,
    tableId: `${gameId}-1`,
    gameId,
    walletId: 1,
    betCents: 1000,
    view,
    seedCommit: 'abc',
    atMs: 0,
  });

const event = (gameId: string, eventType: string, payload: Record<string, unknown>, seq = 1) =>
  frame({
    type: 'round_event',
    roundId: 1,
    tableId: `${gameId}-1`,
    gameId,
    seq,
    actor: 'bot',
    eventType,
    payload,
    atMs: 0,
  });

function feed(s: State, f: MetaFrame | MetaFrame[]): State {
  for (const one of Array.isArray(f) ? f : [f]) {
    s = reducer(s, { type: 'frame', frame: one });
  }
  return s;
}

// ═════════════════════════════════════════════════════════════
// 各游戏的画面叠加
// ═════════════════════════════════════════════════════════════

test('老虎机：三个 reel_stop 依次填进三个转轴', () => {
  let s = feed(initialState, started('slots'));
  s = feed(s, event('slots', 'reel_stop', { reel: 0, symbol: 5, label: '7️⃣' }, 1));
  s = feed(s, event('slots', 'reel_stop', { reel: 1, symbol: 5, label: '7️⃣' }, 2));
  assert.deepEqual(s.tables['slots-1'].view.labels, ['7️⃣', '7️⃣', '❔']);

  s = feed(s, event('slots', 'reel_stop', { reel: 2, symbol: 5, label: '7️⃣' }, 3));
  s = feed(s, event('slots', 'result', { multiplier: 150 }, 4));

  assert.deepEqual(s.tables['slots-1'].view.labels, ['7️⃣', '7️⃣', '7️⃣']);
  assert.equal(s.tables['slots-1'].view.revealed, true);
  assert.equal(s.tables['slots-1'].view.multiplier, 150);
});

test('轮盘：押注帧与开奖帧分别落到 bet / winning', () => {
  let s = feed(initialState, started('roulette', { bet: 'red', revealed: false }));
  assert.equal(s.tables['roulette-1'].view.bet, 'red');
  assert.equal(s.tables['roulette-1'].view.winning, undefined);

  s = feed(s, event('roulette', 'ball_drop', { winning: 17, color: 'black' }, 2));
  assert.equal(s.tables['roulette-1'].view.winning, 17);
  assert.equal(s.tables['roulette-1'].view.color, 'black');
  assert.equal(s.tables['roulette-1'].view.revealed, true);
});

test('龙虎斗：两张牌 + 比牌结果', () => {
  let s = feed(initialState, started('dragon-tiger', { bet: 'dragon', revealed: false }));
  s = feed(s, event('dragon-tiger', 'card_dealt', { side: 'dragon', card: { rank: 12, label: 'K', suit: '♠' } }, 1));
  s = feed(s, event('dragon-tiger', 'card_dealt', { side: 'tiger', card: { rank: 3, label: '3', suit: '♥' } }, 2));

  assert.equal((s.tables['dragon-tiger-1'].view.dragon as { label: string }).label, 'K');
  assert.equal((s.tables['dragon-tiger-1'].view.tiger as { label: string }).label, '3');
  assert.equal(s.tables['dragon-tiger-1'].view.revealed, false);

  s = feed(s, event('dragon-tiger', 'showdown', { winner: 'dragon' }, 3));
  assert.equal(s.tables['dragon-tiger-1'].view.winner, 'dragon');
  assert.equal(s.tables['dragon-tiger-1'].view.revealed, true);
});

test('大火箭：飞行读数与两种结局', () => {
  let s = feed(initialState, started('crash', { revealed: false }));
  s = feed(s, event('crash', 'rocket_progress', { atMs: 5000, multiplier: 2 }, 1));
  assert.deepEqual(s.tables['crash-1'].view.flying, { atMs: 5000, multiplier: 2 });
  assert.equal(s.tables['crash-1'].view.revealed, false);

  // 落袋
  let cash = feed(s, event('crash', 'cashout', { multiplier: 2, payoutCents: 2000 }, 2));
  assert.equal(cash.tables['crash-1'].view.revealed, true);
  assert.equal(cash.tables['crash-1'].view.busted, false);
  assert.equal(cash.tables['crash-1'].view.multiplier, 2);
  assert.equal(cash.tables['crash-1'].view.flying, null);

  // 崩盘
  let bust = feed(s, event('crash', 'rocket_crash', { crashPoint: 1.5, atMs: 3000 }, 2));
  assert.equal(bust.tables['crash-1'].view.busted, true);
  assert.equal(bust.tables['crash-1'].view.crashPoint, 1.5);
});

test('黑杰克：要牌往手牌里追加，翻开暗牌是替换而不是追加', () => {
  // 开局：闲家两张、庄家一张明牌（暗牌不在 view 里）
  let s = feed(
    initialState,
    started('blackjack', {
      revealed: false,
      player: [
        { rank: '9', suit: '♥' },
        { rank: '4', suit: '♠' },
      ],
      dealer: [{ rank: '5', suit: '♥' }],
      playerTotal: 13,
    }),
  );
  assert.equal((s.tables['blackjack-1'].view.player as unknown[]).length, 2);
  assert.equal((s.tables['blackjack-1'].view.dealer as unknown[]).length, 1);

  // 要牌 → 三张
  s = feed(s, event('blackjack', 'deal', { side: 'player', card: { rank: 'K', suit: '♥' } }, 1));
  assert.equal((s.tables['blackjack-1'].view.player as unknown[]).length, 3);
  assert.equal(s.tables['blackjack-1'].view.playerTotal, null);

  // 庄家翻暗牌 → 依然是两张（替换掉占位，不是追加）
  s = feed(s, event('blackjack', 'reveal', { card: { rank: '5', suit: '♥' } }, 2));
  assert.equal((s.tables['blackjack-1'].view.dealer as unknown[]).length, 2);
  assert.equal(
    (s.tables['blackjack-1'].view.dealer as { rank: string }[])[1].rank,
    '5',
  );

  // 庄家继续补牌 → 三张
  s = feed(s, event('blackjack', 'deal', { side: 'dealer', card: { rank: '9', suit: '♣' } }, 3));
  assert.equal((s.tables['blackjack-1'].view.dealer as unknown[]).length, 3);
});

test('黑杰克：暗牌占位符 back=true 会推进一张背面牌', () => {
  const v = applyEvent('blackjack', { dealer: [] }, 'deal', {
    side: 'dealer',
    back: true,
  });
  assert.equal((v.dealer as unknown[]).length, 1);
  assert.equal((v.dealer as { hidden?: boolean }[])[0].hidden, true);
});

test('黑杰克：手里已有背面占位时，reveal 是替换而不是再追加一张', () => {
  // 这条路径对应「不从 round_started 重置、纯逐帧累积」的情形
  let v = applyEvent('blackjack', { dealer: [] }, 'deal', {
    side: 'dealer',
    card: { rank: '5', suit: '♥' },
  });
  v = applyEvent('blackjack', v, 'deal', { side: 'dealer', back: true });
  assert.equal((v.dealer as unknown[]).length, 2);

  v = applyEvent('blackjack', v, 'reveal', { card: { rank: '9', suit: '♣' } });
  assert.equal((v.dealer as unknown[]).length, 2, '替换掉占位，总数不变');
  assert.equal((v.dealer as { rank: string }[])[1].rank, '9');
});

// ═════════════════════════════════════════════════════════════
// 帧语义
// ═════════════════════════════════════════════════════════════

test('round_started 会重置画面，不会把上一局的牌叠过来', () => {
  let s = feed(initialState, started('slots', {}, 1));
  s = feed(s, event('slots', 'reel_stop', { reel: 0, symbol: 5, label: '7️⃣' }, 1));
  assert.deepEqual(s.tables['slots-1'].view.labels, ['7️⃣', '❔', '❔']);

  // 新的一局，view 应当从服务端给的权威快照重新开始
  s = feed(s, started('slots', {}, 2));
  assert.equal(s.tables['slots-1'].roundId, 2);
  assert.equal(s.tables['slots-1'].view.labels, undefined);
  assert.equal(s.tables['slots-1'].frames.length, 0);
});

test('wallet_update 会更新余额、留下脉冲并写进事件流', () => {
  const snap: PlaygroundSnapshot = {
    wallets: [
      {
        id: 7,
        owner_type: 'agent',
        owner_id: 'x',
        display_name: '测试员',
        balance_cents: 100_00,
        created_at: '',
      },
    ],
    tables: [],
    games: [],
    bots: [],
    recentRounds: [],
    reconcile: [],
  };
  let s = reducer(initialState, { type: 'snapshot', snapshot: snap });
  assert.equal(s.wallets[7].balance_cents, 100_00);

  s = feed(
    s,
    frame({
      type: 'wallet_update',
      walletId: 7,
      balanceCents: 120_00,
      deltaCents: 20_00,
      reason: 'payout',
      atMs: 0,
    }),
  );

  assert.equal(s.wallets[7].balance_cents, 120_00);
  assert.equal(s.walletPulse[7].delta, 20_00);
  assert.ok(s.feed[0].text.includes('入账'));
});

test('reasoning 进入决策理由列表，并挂到对应桌台上', () => {
  const s = feed(
    initialState,
    frame({
      type: 'reasoning',
      roundId: 5,
      tableId: 'crash-1',
      actor: '德尔塔',
      gameId: 'crash',
      text: '2 倍就跑，不贪。',
      atMs: 0,
    }),
  );
  assert.equal(s.reasonings.length, 1);
  assert.equal(s.reasonings[0].actor, '德尔塔');
  assert.equal(s.tables['crash-1'].reasoning?.text, '2 倍就跑，不贪。');
});

test('round_settled 会把结果记进该桌走势', () => {
  let s = feed(initialState, started('roulette', {}, 11));
  s = feed(
    s,
    frame({
      type: 'round_settled',
      roundId: 11,
      tableId: 'roulette-1',
      gameId: 'roulette',
      walletId: 1,
      status: 'settled',
      payoutCents: 3600,
      netCents: 2600,
      balanceAfter: 12600,
      serverSeed: 'seed',
      breakdown: {},
      atMs: 0,
    }),
  );

  const t = s.tables['roulette-1'];
  assert.equal(t.status, 'settled');
  assert.equal(t.history.length, 1);
  assert.equal(t.history[0].netCents, 2600);
  assert.equal(t.history[0].betCents, 1000);
  assert.equal(t.lastResult?.payoutCents, 3600);
  assert.equal(t.view.settled, true);
});

test('事件流有上限，不会无限增长', () => {
  let s = initialState;
  for (let i = 0; i < MAX_FEED + 40; i += 1) {
    s = feed(
      s,
      frame({
        type: 'wallet_update',
        walletId: 1,
        balanceCents: i,
        deltaCents: 1,
        reason: 'grant',
        atMs: 0,
      }),
    );
  }
  assert.equal(s.feed.length, MAX_FEED);
});

// ═════════════════════════════════════════════════════════════
// 纯函数性（React 严格模式会重复调用 reducer）
// ═════════════════════════════════════════════════════════════

test('reducer 是纯函数：同样的输入跑两次结果一致', () => {
  const snap: PlaygroundSnapshot = {
    wallets: [],
    tables: [{ tableId: 'slots-1', gameId: 'slots', players: 1, lastActivity: null, openRounds: 0 }],
    games: [],
    bots: [],
    recentRounds: [],
    reconcile: [],
  };
  const a = reducer(initialState, { type: 'snapshot', snapshot: snap });
  const b = reducer(initialState, { type: 'snapshot', snapshot: snap });
  assert.deepEqual(a, b);

  const f = event('slots', 'reel_stop', { reel: 1, symbol: 2, label: '🔔' }, 1);
  assert.deepEqual(reducer(a, { type: 'frame', frame: f }), reducer(b, { type: 'frame', frame: f }));
});

test('快照会用最近对局预填事件流（打开页面不至于空白）', () => {
  const snap: PlaygroundSnapshot = {
    wallets: [],
    // 快照本身不创建桌位（见 reducer 里的说明），所以这里只提供这张桌的元信息：
    // lastActivity 得是「刚刚」，否则它会被当成凉掉的桌位回收。
    tables: [
      { tableId: 'slots-1', gameId: 'slots', players: 1, lastActivity: utcAgo(30_000), openRounds: 0 },
    ],
    games: [],
    bots: [],
    recentRounds: [
      {
        id: 9,
        gameId: 'slots',
        tableId: 'slots-1',
        walletId: 1,
        betCents: 500,
        status: 'settled',
        payoutCents: 4000,
        netCents: 3500,
        seedCommit: 'c',
        serverSeed: 's',
        clientSeed: 'x',
        nonce: 1,
        startedAt: '2026-10-06 07:50:42',
        settledAt: '2026-10-06 07:50:42',
        view: {},
      },
      {
        id: 8,
        gameId: 'slots',
        tableId: 'slots-1',
        walletId: 1,
        betCents: 500,
        status: 'awaiting_action',
        payoutCents: 0,
        netCents: 0,
        seedCommit: 'c',
        serverSeed: null,
        clientSeed: 'x',
        nonce: 2,
        startedAt: '2026-10-06 07:50:43',
        settledAt: null,
        view: {},
      },
    ],
    reconcile: [],
  };

  // ① 事件流：直接打开页面时用最近对局垫底（这一步不依赖桌位是否存在）
  const seeded = reducer(initialState, { type: 'snapshot', snapshot: snap });
  assert.equal(seeded.ready, true);
  // 只收已结算的那一局；未结算的不该出现在历史里
  assert.equal(seeded.feed.length, 1);
  assert.ok(seeded.feed[0].text.includes('第 9 局'));

  // ② 走势：桌位先由实时帧建立（快照不创建桌位），快照再把历史补进去
  let s = feed(initialState, started('slots', {}, 9));
  s = reducer(s, { type: 'snapshot', snapshot: snap });
  assert.equal(s.tables['slots-1'].history.length, 1);
});

test('已有实时事件时，快照不会把历史插到最前面', () => {
  const live = feed(
    initialState,
    frame({
      type: 'wallet_update',
      walletId: 1,
      balanceCents: 1,
      deltaCents: 1,
      reason: 'grant',
      atMs: 0,
    }),
  );
  const snap: PlaygroundSnapshot = {
    wallets: [],
    tables: [],
    games: [],
    bots: [],
    recentRounds: [
      {
        id: 3,
        gameId: 'slots',
        tableId: 'slots-1',
        walletId: 1,
        betCents: 100,
        status: 'settled',
        payoutCents: 0,
        netCents: -100,
        seedCommit: 'c',
        serverSeed: 's',
        clientSeed: 'x',
        nonce: 1,
        startedAt: '2026-10-06 07:50:42',
        settledAt: '2026-10-06 07:50:42',
        view: {},
      },
    ],
    reconcile: [],
  };
  const s = reducer(live, { type: 'snapshot', snapshot: snap });
  assert.equal(s.feed.length, 1);
  assert.ok(s.feed[0].text.includes('入账'));
});

// ═════════════════════════════════════════════════════════════
// Bot 自主换游戏：位置固定 + 明确提示
// ═════════════════════════════════════════════════════════════

const switched = (
  tableId: string,
  fromGameId: string,
  toGameId: string,
  reason = '我连输三把了，换一种规则重新判断。',
) =>
  frame({
    type: 'game_switch',
    botId: 'alpha',
    displayName: '阿尔法',
    tableId,
    fromGameId,
    toGameId,
    reason,
    atMs: 0,
  });

test('换游戏：这一格换成新游戏，旧画面被清干净', () => {
  let s = feed(initialState, started('slots'));
  s = feed(s, event('slots', 'reel_stop', { reel: 0, symbol: 5, label: '7️⃣' }, 1));
  assert.ok(s.tables['slots-1'].frames.length > 0, '换之前这一格应该有画面');

  s = feed(s, switched('slots-1', 'slots', 'plinko'));
  const t = s.tables['slots-1'];
  assert.equal(t.gameId, 'plinko', '游戏已切换');
  assert.equal(t.frames.length, 0, '旧游戏的事件残留必须清空');
  assert.deepEqual(t.view, {}, '旧局面必须清空');
  assert.equal(t.status, 'idle');
  assert.equal(t.gameSwitch?.toGameId, 'plinko');
});

test('换游戏：feed 里出现一条醒目的「明确提示」，带完整切换理由', () => {
  const reason = '最近连续 3 局没赢。我不打算只靠加注硬扛，先从「老虎机」切到「弹珠台」。';
  const s = feed(initialState, switched('bot-alpha', 'slots', 'plinko', reason));
  const item = s.feed.find((x) => x.kind === 'switch');
  assert.ok(item, 'feed 里应该有一条 kind=switch 的条目');
  assert.ok(item!.text.includes('🔔 明确提示'), '必须带醒目的提示前缀');
  assert.ok(item!.text.includes('老虎机') && item!.text.includes('弹珠台'), '必须写清从哪款切到哪款');
  assert.ok(item!.text.includes(reason), '切换理由必须原样带出来，不能省略');
  assert.equal(item!.tableId, 'bot-alpha');
});

test('换游戏：桌号不变，Bot 在前端的位置就不会跳', () => {
  let s = initialState;
  const hops: Array<[string, string]> = [
    ['slots', 'plinko'],
    ['plinko', 'keno'],
    ['keno', 'craps'],
  ];
  let current = 'slots';
  for (const [, to] of hops) {
    s = feed(s, switched('bot-alpha', current, to));
    current = to;
  }
  // 三次换游戏之后，桌位键仍然只有一个，且还是 bot-alpha
  assert.deepEqual(Object.keys(s.tables), ['bot-alpha'], '换游戏不应该产生新的格子');
  assert.equal(s.tables['bot-alpha'].gameId, 'craps');
  assert.equal(s.feed.filter((x) => x.kind === 'switch').length, 3);
});

test('快照：每个 Bot 按自己的固定槽位落格，gameId 跟着 Bot 走', () => {
  const snap: PlaygroundSnapshot = {
    wallets: [],
    tables: [],
    games: [],
    bots: [
      { id: 'alpha', displayName: '阿尔法', persona: '赌徒', tableId: 'bot-alpha', gameId: 'keno', walletId: 1, rounds: 3, wins: 1, netCents: -200, lastReasoning: null, running: true },
      { id: 'beta', displayName: '贝塔', persona: '数学派', tableId: 'bot-beta', gameId: 'baccarat', walletId: 2, rounds: 3, wins: 0, netCents: -200, lastReasoning: null, running: true },
      { id: 'gamma', displayName: '伽马', persona: '投机者', tableId: 'bot-gamma', gameId: 'wheel', walletId: 3, rounds: 3, wins: 1, netCents: 100, lastReasoning: null, running: true },
    ],
    recentRounds: [],
    reconcile: [],
  };
  const s = reducer(initialState, { type: 'snapshot', snapshot: snap });
  assert.deepEqual(Object.keys(s.tables).sort(), ['bot-alpha', 'bot-beta', 'bot-gamma']);
  assert.equal(s.tables['bot-alpha'].gameId, 'keno');
  assert.equal(s.tables['bot-beta'].gameId, 'baccarat');
  assert.equal(s.tables['bot-gamma'].gameId, 'wheel');
});

// ═════════════════════════════════════════════════════════════
// 快照里只该长出「正在发生的桌位」
// ═════════════════════════════════════════════════════════════

const tableRow = (
  tableId: string,
  gameId: string,
  openRounds: number,
  msAgo = 60_000,
): TableSummary => ({
  tableId,
  gameId,
  players: 1,
  lastActivity: utcAgo(msAgo),
  openRounds,
});

const bot = (id: string, displayName: string, tableId: string, gameId: string, walletId: number) => ({
  id,
  displayName,
  persona: '测试',
  tableId,
  gameId,
  walletId,
  rounds: 0,
  wins: 0,
  netCents: 0,
  lastReasoning: null,
  running: true,
});

const snapWith = (tables: TableSummary[], bots: PlaygroundSnapshot['bots']): PlaygroundSnapshot => ({
  wallets: [],
  tables,
  games: [],
  bots,
  recentRounds: [],
  reconcile: [],
});

test('快照：历史上用过的冷桌号不再占格子（幽灵桌）', () => {
  // 后端 tables() 是 GROUP BY table_id, game_id 的统计，会把早期测试留下的
  // blackjack-1 / roulette-1 之类一起吐出来。它们没有 Bot、也没有未结束的对局，
  // 观察台不该为它们画格子 —— 曾经因此出现「5 个 Bot 却排 12 个格子」。
  const snap = snapWith(
    [
      tableRow('blackjack-1', 'blackjack', 0, 3 * 60 * 60 * 1000),
      tableRow('roulette-1', 'roulette', 0, 3 * 60 * 60 * 1000),
      tableRow('slots-1', 'slots', 0, 3 * 60 * 60 * 1000),
      tableRow('bot-alpha', 'keno', 0),
      tableRow('bot-beta', 'baccarat', 0),
    ],
    [bot('alpha', '阿尔法', 'bot-alpha', 'keno', 1), bot('beta', '贝塔', 'bot-beta', 'baccarat', 2)],
  );

  const s = reducer(initialState, { type: 'snapshot', snapshot: snap });
  assert.deepEqual(Object.keys(s.tables).sort(), ['bot-alpha', 'bot-beta']);
});

test('快照：同一张桌的多行不会变成多个格子，Bot 的 gameId 以 snapshot.bots 为准', () => {
  const snap = snapWith(
    [
      tableRow('bot-alpha', 'slots', 0, 60_000),
      tableRow('bot-alpha', 'keno', 1, 30_000),
      tableRow('bot-alpha', 'wheel', 0, 10_000),
    ],
    [bot('alpha', '阿尔法', 'bot-alpha', 'keno', 1)],
  );

  const s = reducer(initialState, { type: 'snapshot', snapshot: snap });
  assert.deepEqual(Object.keys(s.tables), ['bot-alpha'], '一张桌只该有一个格子');
  assert.equal(s.tables['bot-alpha'].gameId, 'keno', 'gameId 必须以 snapshot.bots 为准');
});

test('快照：不会为历史桌号凭空创建格子', () => {
  // 快照里的 tables 是「按桌号 × 游戏分组的历史统计」，不是「现在有这些桌」。
  // 拿它当桌位清单，就会把早期测试留下的桌号全渲染出来。
  const snap = snapWith([tableRow('mcp-agent-1', 'roulette', 0, 20_000)], []);
  const s = reducer(initialState, { type: 'snapshot', snapshot: snap });
  assert.deepEqual(Object.keys(s.tables), []);
});

test('外部 MCP agent：实时帧让它出现，凉掉之后被回收', () => {
  const agentStarted = (roundId: number) =>
    frame({
      type: 'round_started',
      roundId,
      tableId: 'mcp-agent-1',
      gameId: 'roulette',
      walletId: 9,
      betCents: 100,
      view: {},
      seedCommit: 'c',
      atMs: 0,
    });
  const agentSettled = (roundId: number) =>
    frame({
      type: 'round_settled',
      roundId,
      tableId: 'mcp-agent-1',
      gameId: 'roulette',
      walletId: 9,
      status: 'settled',
      payoutCents: 0,
      netCents: -100,
      balanceAfter: 900,
      serverSeed: 's',
      breakdown: {},
      atMs: 0,
    });

  // 1) 它下注 → 观察台上出现它的桌位
  let s = feed(initialState, agentStarted(5));
  assert.deepEqual(Object.keys(s.tables), ['mcp-agent-1']);

  // 2) 结算了，但后端说它刚刚还在活动 → 继续留着（观众还能看到这一局的结果）
  s = feed(s, agentSettled(5));
  s = reducer(s, {
    type: 'snapshot',
    snapshot: snapWith([tableRow('mcp-agent-1', 'roulette', 0, 20_000)], []),
  });
  assert.deepEqual(Object.keys(s.tables), ['mcp-agent-1'], '刚玩过的不该立刻消失');

  // 3) 后端那边也早就凉了 → 下一次快照把它回收掉
  s = reducer(s, {
    type: 'snapshot',
    snapshot: snapWith([tableRow('mcp-agent-1', 'roulette', 0, 3 * 60 * 60 * 1000)], []),
  });
  assert.deepEqual(Object.keys(s.tables), [], '早就凉掉的桌位不该一直占着');
});

test('快照：被放弃的旧对局不算「还在玩」（openRounds 不是活着的证据）', () => {
  // 演示库里躺着这种桌：很久以前开了局、状态卡在 awaiting_action 再没人动。
  // 如果拿 openRounds > 0 当「活着」的判据，它们会永远占着格子。
  const snap = snapWith(
    [
      tableRow('blackjack-1', 'blackjack', 1, 6 * 60 * 60 * 1000),
      tableRow('crash-1', 'crash', 3, 6 * 60 * 60 * 1000),
      tableRow('bot-alpha', 'keno', 0),
    ],
    [bot('alpha', '阿尔法', 'bot-alpha', 'keno', 1)],
  );

  const s = reducer(initialState, { type: 'snapshot', snapshot: snap });
  assert.deepEqual(Object.keys(s.tables), ['bot-alpha']);
});

test('快照：上一轮留下的幽灵桌会在下一次快照时被清掉', () => {
  // 让一张桌从实时帧里长出来，并且**已经结算**（没有未结束的对局）。
  let s = feed(initialState, started('slots'));
  s = feed(
    s,
    frame({
      type: 'round_settled',
      roundId: 1,
      tableId: 'slots-1',
      gameId: 'slots',
      walletId: 1,
      status: 'settled',
      payoutCents: 0,
      netCents: -1000,
      balanceAfter: 9000,
      serverSeed: 'seed',
      breakdown: {},
      atMs: 0,
    }),
  );
  assert.deepEqual(Object.keys(s.tables), ['slots-1']);

  // 下一次快照里它既不是 Bot 槽位、也没有未结束对局、也早就不活动了 → 应当消失
  const snap = snapWith(
    [tableRow('slots-1', 'slots', 0, 3 * 60 * 60 * 1000), tableRow('bot-alpha', 'keno', 0)],
    [bot('alpha', '阿尔法', 'bot-alpha', 'keno', 1)],
  );
  s = reducer(s, { type: 'snapshot', snapshot: snap });
  assert.deepEqual(Object.keys(s.tables), ['bot-alpha']);
});

test('快照：正打着对局的桌位即使快照暂时没列出来也不会被误清', () => {
  // 实时帧刚开了局，但快照是 15 秒前拉的 —— 不能因为「快照里没有」就把桌子抹掉。
  let s = feed(initialState, started('blackjack'));
  s = reducer(s, { type: 'snapshot', snapshot: snapWith([], []) });
  assert.deepEqual(Object.keys(s.tables), ['blackjack-1'], '未结束的对局必须留着');
});
