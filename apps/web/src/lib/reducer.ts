/**
 * 观察台的状态机（纯函数，不依赖 React）。
 *
 * 单独拆出来的理由：这里是整个前端最容易出错的地方 —— 每个游戏的事件
 * 序列都不一样，把「一帧广播」翻译成「此刻画面上应该是什么」，全靠这里。
 * 拆成纯模块之后就能用 node:test 直接跑，不必起浏览器。
 */

import type {
  FeedItem,
  MetaFrame,
  PlaygroundSnapshot,
  ReasoningItem,
  SettledRecord,
  TableRuntime,
  TableSummary,
  WalletRow,
} from './types';
import { betLabel, coins, gameLabel } from './format';

export const MAX_FEED = 250;
export const MAX_REASONING = 120;
export const MAX_HISTORY_PER_TABLE = 24;

/**
 * 非 Bot 桌位「还热」的时限。
 *
 * snapshot.tables 是按 (桌号, 游戏) 分组的历史统计，会把**历史上用过的所有桌号**
 * 都吐出来（比如早期测试留下的 `blackjack-1`、`roulette-1`）。观察台只该画
 * 「正在发生的事」，所以除了脚本 Bot 的固定槽位之外，其余桌位只在最近还在活动时才占格子。
 *
 * ⚠️ 不要用 `openRounds > 0` 当「活着」的判据 —— 那个字段数的是
 * `status = 'awaiting_action'` 的对局，而**被放弃的局会永远挂在那里**。
 * 演示库里就躺着好几张这样的桌（09:09 开的局，之后再没人动过）。
 * 真正能说明「有人在场」的只有 lastActivity。
 *
 * 已知边界：lastActivity 取的是 `MAX(started_at)`，一局从头到尾只有一个时间戳。
 * 所以单局若开了超过这个时限还没结算，桌子会被判定为冷 —— 对脚本 Bot（每局几秒）
 * 和外部 agent（每手一分钟内）都够用。
 */
const RECENT_TABLE_MS = 10 * 60 * 1000;

/** 这张桌最近还在动吗？ */
function isWarm(t: TableSummary | undefined): boolean {
  if (!t?.lastActivity) return false;
  // 后端的 lastActivity 是 SQLite 的 UTC 文本（"2026-10-06 09:28:57"），
  // 必须补上 T 和 Z 再解析，否则会被当成本地时间、算出差 8 小时的偏差。
  const at = Date.parse(`${t.lastActivity.replace(' ', 'T')}Z`);
  return Number.isFinite(at) && Date.now() - at < RECENT_TABLE_MS;
}

// ─────────────────────────────────────────────────────────────
// 状态
// ─────────────────────────────────────────────────────────────

export interface State {
  ready: boolean;
  connected: boolean;
  serverTime: string | null;
  snapshot: PlaygroundSnapshot | null;
  wallets: Record<number, WalletRow>;
  tables: Record<string, TableRuntime>;
  feed: FeedItem[];
  reasonings: ReasoningItem[];
  /** 钱包 id → 最近一次余额变动，用于做闪烁提示 */
  walletPulse: Record<number, { delta: number; at: number }>;
}

export const initialState: State = {
  ready: false,
  connected: false,
  serverTime: null,
  snapshot: null,
  wallets: {},
  tables: {},
  feed: [],
  reasonings: [],
  walletPulse: {},
};

export type Action =
  | { type: 'snapshot'; snapshot: PlaygroundSnapshot }
  | { type: 'ws_open' }
  | { type: 'ws_close' }
  | { type: 'frame'; frame: MetaFrame }
  | { type: 'clear_feed' };

// ─────────────────────────────────────────────────────────────
// 事件 → 画面 的增量规则
// ─────────────────────────────────────────────────────────────

/**
 * 把一帧 round_event 叠加到当前 view 上。
 * 每个游戏只认自己的事件类型，互不干扰。
 */
export function applyEvent(
  gameId: string,
  view: Record<string, unknown>,
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...view };

  switch (gameId) {
    case 'roulette': {
      if (eventType === 'bet_placed') next.bet = payload.bet;
      if (eventType === 'ball_drop') {
        next.revealed = true;
        next.winning = payload.winning;
        next.color = payload.color;
      }
      break;
    }

    case 'slots': {
      if (eventType === 'reel_stop') {
        const idx = Number(payload.reel);
        const labels = [...((next.labels as string[]) ?? ['❔', '❔', '❔'])];
        const reels = [...((next.reels as number[]) ?? [-1, -1, -1])];
        labels[idx] = String(payload.label ?? '❔');
        reels[idx] = Number(payload.symbol);
        next.labels = labels;
        next.reels = reels;
      }
      if (eventType === 'result') {
        next.revealed = true;
        next.multiplier = Number(payload.multiplier ?? 0);
      }
      break;
    }

    case 'dragon-tiger': {
      if (eventType === 'bet_placed') next.bet = payload.bet;
      if (eventType === 'card_dealt') next[String(payload.side)] = payload.card;
      if (eventType === 'showdown') {
        next.revealed = true;
        next.winner = payload.winner;
      }
      break;
    }

    case 'crash': {
      if (eventType === 'rocket_progress') {
        // 只作为飞行中的实时读数，不写进权威 view
        next.flying = { atMs: payload.atMs, multiplier: payload.multiplier };
      }
      if (eventType === 'rocket_crash') {
        next.revealed = true;
        next.busted = true;
        next.crashPoint = payload.crashPoint;
        next.flying = null;
      }
      if (eventType === 'cashout') {
        next.revealed = true;
        next.busted = false;
        next.multiplier = payload.multiplier;
        next.flying = null;
      }
      break;
    }

    case 'blackjack': {
      if (eventType === 'deal') {
        const side = String(payload.side);
        const list = [...((next[side] as unknown[]) ?? [])];
        if (payload.back) list.push({ rank: '?', suit: '?', hidden: true });
        else list.push(payload.card);
        next[side] = list;
        if (side === 'player') next.playerTotal = null;
      }
      if (eventType === 'reveal') {
        const list = [...((next.dealer as unknown[]) ?? [])];
        const lastIdx = list.length - 1;
        const last = list[lastIdx] as { hidden?: boolean } | undefined;
        if (last && last.hidden) list[lastIdx] = payload.card;
        else list.push(payload.card);
        next.dealer = list;
        next.dealerTotal = null;
      }
      if (eventType === 'bust') {
        next.playerTotal = Number(payload.total ?? 0);
        next.busted = true;
      }
      if (eventType === 'double') next.doubled = true;
      if (eventType === 'blackjack') next.playerBlackjack = true;
      break;
    }

    case 'baccarat': {
      if (eventType === 'card_dealt') {
        const side = String(payload.side);
        const cards = [...((next[side] as unknown[]) ?? [])];
        cards.push(payload.card);
        next[side] = cards;
      }
      if (eventType === 'showdown') {
        next.revealed = true;
        next.playerTotal = payload.playerTotal;
        next.bankerTotal = payload.bankerTotal;
        next.winner = payload.winner;
      }
      break;
    }

    case 'sicbo': {
      if (eventType === 'dice_roll') {
        next.dice = payload.dice;
        next.revealed = true;
      }
      if (eventType === 'result') {
        next.dice = payload.dice;
        next.total = payload.total;
        next.isTriple = payload.isTriple;
        next.multiplier = payload.multiplier;
        next.revealed = true;
      }
      break;
    }

    case 'wheel': {
      if (eventType === 'wheel_stop') {
        next.landedIndex = payload.landedIndex;
        next.multiplier = payload.multiplier;
        next.revealed = true;
      }
      break;
    }

    case 'plinko': {
      if (eventType === 'plinko_bounce') {
        next.path = [...((next.path as string[]) ?? []), payload.dir];
      }
      if (eventType === 'result') {
        next.slot = payload.slot;
        next.multiplier = payload.multiplier;
        next.risk = payload.risk;
        next.revealed = true;
      }
      break;
    }

    case 'keno': {
      if (eventType === 'keno_batch') {
        next.drawn = [...((next.drawn as number[]) ?? []), ...((payload.numbers as number[]) ?? [])];
      }
      if (eventType === 'result') {
        next.drawn = next.drawn ?? [];
        next.hits = payload.hits;
        next.hitCount = payload.hitCount;
        next.multiplier = payload.multiplier;
        next.revealed = true;
      }
      break;
    }

    case 'craps': {
      if (eventType === 'dice') {
        next.lastDice = [payload.a, payload.b];
        next.total = payload.total;
        next.rolls = [...((next.rolls as unknown[]) ?? []), [payload.a, payload.b]];
      }
      if (eventType === 'point_set') {
        next.point = payload.point;
        next.phase = 'point';
      }
      if (eventType === 'win' || eventType === 'lose') {
        next.finished = true;
        next.won = eventType === 'win';
        next.revealed = true;
      }
      break;
    }

    case 'holdem': {
      if (eventType === 'flop') next.board = payload.cards;
      if (eventType === 'turn' || eventType === 'river') {
        next.board = [...((next.board as unknown[]) ?? []), payload.card];
      }
      if (eventType === 'fold') {
        next.decision = 'fold';
        next.revealed = true;
      }
      if (eventType === 'showdown') {
        next.revealed = true;
        next.winner = payload.winner;
        next.playerHandName = payload.playerHand;
        next.dealerHandName = payload.dealerHand;
      }
      break;
    }

    case 'video-poker': {
      if (eventType === 'replacement') {
        const hand = [...((next.hand as unknown[]) ?? [])];
        hand[Number(payload.position)] = payload.card;
        next.hand = hand;
      }
      if (eventType === 'hold') next.held = payload.positions;
      if (eventType === 'result') {
        next.hand = payload.hand;
        next.handName = payload.handName;
        next.multiplier = payload.multiplier;
        next.label = payload.label;
        next.revealed = true;
      }
      break;
    }

    case 'hi-lo': {
      if (eventType === 'guess') {
        next.lastGuess = payload.direction;
        next.nextCard = payload.nextCard;
      }
      if (eventType === 'correct') {
        next.multiplier = payload.multiplier;
        next.guesses = payload.guesses;
        next.correct = true;
      }
      if (eventType === 'wrong') {
        next.multiplier = 0;
        next.guesses = payload.guesses;
        next.correct = false;
        next.revealed = true;
      }
      if (eventType === 'collect' || eventType === 'max_cashout') {
        next.revealed = true;
        next.finished = true;
      }
      break;
    }

    default:
      break;
  }

  return next;
}

/** 把一帧转成事件流里的一句人话 */
export function describeFrame(frame: MetaFrame): string {
  switch (frame.type) {
    case 'round_started':
      return `${gameLabel(frame.gameId)} 开局，下注 ${coins(frame.betCents)}`;
    case 'round_settled':
      return `${gameLabel(frame.gameId)} 第 ${frame.roundId} 局结算，净 ${coins(frame.netCents)}`;
    case 'wallet_update':
      return `钱包 #${frame.walletId} ${frame.deltaCents >= 0 ? '入账' : '出账'} ${coins(Math.abs(frame.deltaCents))}（${frame.reason}）`;
    case 'reasoning':
      return `${frame.actor}：${frame.text}`;
    case 'game_switch':
      return `🔔 明确提示：${frame.displayName} 从「${gameLabel(frame.fromGameId)}」切换到「${gameLabel(frame.toGameId)}」。切换原因：${frame.reason}`;
    case 'round_event': {
      const p = frame.payload ?? {};
      switch (frame.eventType) {
        case 'bet_placed':
          return `押注 ${betLabel(p.bet)}`;
        case 'wheel_spin':
          return '轮盘转动…';
        case 'ball_drop':
          return `开出 ${p.winning} 号（${p.color === 'red' ? '红' : p.color === 'black' ? '黑' : '绿'}）`;
        case 'reel_stop':
          return `第 ${Number(p.reel) + 1} 轴停在 ${p.label}`;
        case 'reels_loaded':
          return '转轴就绪';
        case 'result':
          return Number(p.multiplier) > 0 ? `中奖 ${p.multiplier} 倍` : '未中奖';
        case 'card_dealt': {
          const c = p.card as { rank: string; suit: string } | undefined;
          return c ? `${p.side === 'dragon' ? '龙' : '虎'}方 ${c.rank}${c.suit}` : '发牌';
        }
        case 'showdown':
          return `比牌：${p.winner === 'dragon' ? '龙' : p.winner === 'tiger' ? '虎' : '和'}胜`;
        case 'rocket_launch':
          return '🚀 起飞';
        case 'rocket_progress':
          return `飞到 ${p.multiplier}×`;
        case 'rocket_crash':
          return `💥 崩在 ${p.crashPoint}×`;
        case 'cashout':
          return `落袋 ${p.multiplier}×`;
        case 'deal':
          return p.back ? '庄家扣一张暗牌' : `${p.side === 'player' ? '闲家' : '庄家'}发到一张牌`;
        case 'reveal':
          return '庄家翻开暗牌';
        case 'bust':
          return `爆牌（${p.total} 点）`;
        case 'double':
          return '加倍！';
        case 'blackjack':
          return '🂡 黑杰克！';
        case 'dealer_stand':
          return '庄家停牌';
        default:
          return frame.eventType;
      }
    }
    default:
      return (frame as { type: string }).type;
  }
}

// ─────────────────────────────────────────────────────────────
// Reducer
// ─────────────────────────────────────────────────────────────

export function emptyTable(tableId: string, gameId: string): TableRuntime {
  return {
    tableId,
    gameId,
    roundId: null,
    walletId: null,
    betCents: 0,
    status: 'idle',
    view: {},
    frames: [],
    lastResult: null,
    history: [],
    reasoning: null,
    startedAt: 0,
  };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'snapshot': {
      const wallets: Record<number, WalletRow> = {};
      for (const w of action.snapshot.wallets) wallets[w.id] = w;

      // 用最近的对局预填事件流与走势 —— 否则刚打开页面会是一片空白，
      // 得干等到下一次有人下注才「活」起来。
      const seedFeed: FeedItem[] = [];
      const historyByTable = new Map<string, SettledRecord[]>();

      for (const r of action.snapshot.recentRounds) {
        if (r.status !== 'settled') continue;
        const at = r.settledAt ? Date.parse(`${r.settledAt.replace(' ', 'T')}Z`) : Date.now();
        seedFeed.push({
          id: `hist-${r.id}`,
          kind: 'settled',
          at,
          tableId: r.tableId,
          gameId: r.gameId,
          text: `${gameLabel(r.gameId)} 第 ${r.id} 局结算，净 ${coins(r.netCents)}`,
          netCents: r.netCents,
        });
        const list = historyByTable.get(r.tableId) ?? [];
        list.push({
          roundId: r.id,
          walletId: r.walletId,
          betCents: r.betCents,
          payoutCents: r.payoutCents,
          netCents: r.netCents,
          at,
        });
        historyByTable.set(r.tableId, list);
      }

      // snapshot.tables 是「按 (桌号, 游戏) 分组」的历史统计，同一张桌会出现多行，
      // 而且**会把历史上用过的所有桌号都吐出来**。所以它只用来查信息，
      // 绝不用来凭空长出桌位 —— 那正是「5 个 Bot 排出 12 个格子」的成因。
      const liveByTable = new Map<string, TableSummary>();
      for (const t of action.snapshot.tables) {
        const prev = liveByTable.get(t.tableId);
        if (!prev || (t.lastActivity ?? '') > (prev.lastActivity ?? '')) {
          liveByTable.set(t.tableId, t);
        }
      }

      const botTableIds = new Set(action.snapshot.bots.map((b) => b.tableId));

      // 只留三类桌位：
      //   1. 脚本 Bot 的固定槽位 —— 永远在；
      //   2. 手上有没打完的局（running）—— 正打着；
      //   3. 后端那边最近还在活动 —— 外部 MCP agent 刚玩过。
      // 非 Bot 的桌位只可能是「本次会话真的收到过它的实时帧」才存在的
      // （快照不创建它们），所以这里既不会复活历史桌号，也能把凉掉的回收掉。
      const tables: Record<string, TableRuntime> = {};
      for (const [id, prev] of Object.entries(state.tables)) {
        // 前端把服务端的 awaiting_action（等外部 agent 出手）统一渲染成 running，
        // 所以只看 'running' 就等于「手上有没打完的局」。
        const inFlight = prev.status === 'running';
        if (botTableIds.has(id) || inFlight || isWarm(liveByTable.get(id))) tables[id] = prev;
      }

      // 快照只做补充：给已经存在的桌位补历史走势，不创建新桌位。
      for (const [id, prev] of Object.entries(tables)) {
        const hist = (historyByTable.get(id) ?? []).slice(0, MAX_HISTORY_PER_TABLE);
        tables[id] = { ...prev, history: prev.history.length > 0 ? prev.history : hist };
      }

      // 每个脚本 Bot 固定占一格：slot 的桌号始终不变，切游戏只更新这一格的 gameId。
      // gameId 一律以 snapshot.bots 为准。
      for (const bot of action.snapshot.bots) {
        const existing = tables[bot.tableId];
        tables[bot.tableId] = existing
          ? { ...existing, gameId: bot.gameId }
          : emptyTable(bot.tableId, bot.gameId);
      }

      // 实时帧优先：已经有实时 feed 时不要把历史塞到前面
      const feed = state.feed.length > 0 ? state.feed : seedFeed.slice(0, 60);

      return { ...state, ready: true, snapshot: action.snapshot, wallets, tables, feed };
    }

    case 'ws_open':
      return { ...state, connected: true };

    case 'ws_close':
      return { ...state, connected: false };

    case 'clear_feed':
      return { ...state, feed: [], reasonings: [] };

    case 'frame': {
      const f = action.frame;
      const now = f._at ?? Date.now();
      // id 由 WS 回调预先贴好，这样 reducer 保持纯函数
      const uid = f._uid ?? `${f.type}-${String((f as { roundId?: number }).roundId ?? '')}`;

      if (f.type === 'hello') {
        // 握手帧只更新连接状态。**不要**用它来建桌位：
        // 它以前带过一份「历史上用过的桌号」清单，照着建格子会让 5 个 Bot 排出 12 张桌。
        // 桌位来源只有两个 —— snapshot.bots（固定槽位）和实时帧（外部 agent）。
        return { ...state, connected: true, serverTime: f.serverTime };
      }

      if (f.type === 'game_switch') {
        const prev = state.tables[f.tableId] ?? emptyTable(f.tableId, f.toGameId);
        const switchText = describeFrame(f);
        return {
          ...state,
          tables: {
            ...state.tables,
            [f.tableId]: {
              ...prev,
              gameId: f.toGameId,
              status: 'idle',
              view: {},
              frames: [],
              lastResult: null,
              betCents: 0,
              reasoning: { actor: f.displayName, text: f.reason, at: now },
              gameSwitch: {
                fromGameId: f.fromGameId,
                toGameId: f.toGameId,
                reason: f.reason,
                at: now,
              },
            },
          },
          feed: [
            {
              id: uid,
              kind: 'switch' as const,
              at: now,
              tableId: f.tableId,
              gameId: f.toGameId,
              text: switchText,
            },
            ...state.feed,
          ].slice(0, MAX_FEED),
          reasonings: [
            {
              id: uid,
              at: now,
              tableId: f.tableId,
              gameId: f.toGameId,
              actor: f.displayName,
              text: `切换原因：${f.reason}`,
              roundId: 0,
            },
            ...state.reasonings,
          ].slice(0, MAX_REASONING),
        };
      }

      if (f.type === 'wallet_update') {
        const existing = state.wallets[f.walletId];
        const wallets = existing
          ? { ...state.wallets, [f.walletId]: { ...existing, balance_cents: f.balanceCents } }
          : state.wallets;
        return {
          ...state,
          wallets,
          walletPulse: {
            ...state.walletPulse,
            [f.walletId]: { delta: f.deltaCents, at: now },
          },
          feed: [
            {
              id: uid,
              kind: 'wallet' as const,
              at: now,
              tableId: '',
              gameId: '',
              text: describeFrame(f),
            },
            ...state.feed,
          ].slice(0, MAX_FEED),
        };
      }

      if (f.type === 'reasoning') {
        const item: ReasoningItem = {
          id: uid,
          at: now,
          tableId: f.tableId,
          gameId: f.gameId,
          actor: f.actor,
          text: f.text,
          roundId: f.roundId,
        };
        const prev = state.tables[f.tableId] ?? emptyTable(f.tableId, f.gameId);
        return {
          ...state,
          reasonings: [item, ...state.reasonings].slice(0, MAX_REASONING),
          tables: {
            ...state.tables,
            [f.tableId]: {
              ...prev,
              reasoning: { actor: f.actor, text: f.text, at: now },
            },
          },
        };
      }

      if (f.type === 'round_started') {
        const prev = state.tables[f.tableId] ?? emptyTable(f.tableId, f.gameId);
        return {
          ...state,
          tables: {
            ...state.tables,
            [f.tableId]: {
              ...prev,
              gameId: f.gameId,
              roundId: f.roundId,
              walletId: f.walletId,
              betCents: f.betCents,
              status: 'running',
              // 权威初始画面：从这里重新开始叠加
              view: f.view,
              frames: [],
              lastResult: null,
              startedAt: now,
            },
          },
          feed: [
            {
              id: uid,
              kind: 'start' as const,
              at: now,
              tableId: f.tableId,
              gameId: f.gameId,
              text: describeFrame(f),
            },
            ...state.feed,
          ].slice(0, MAX_FEED),
        };
      }

      if (f.type === 'round_event') {
        const prev = state.tables[f.tableId] ?? emptyTable(f.tableId, f.gameId);
        return {
          ...state,
          tables: {
            ...state.tables,
            [f.tableId]: {
              ...prev,
              gameId: f.gameId,
              view: applyEvent(f.gameId, prev.view, f.eventType, f.payload),
              frames: [
                ...prev.frames,
                {
                  seq: f.seq,
                  eventType: f.eventType,
                  payload: f.payload,
                  atMs: f.atMs,
                  actor: f.actor,
                },
              ],
            },
          },
          feed: [
            {
              id: uid,
              kind: 'event' as const,
              at: now,
              tableId: f.tableId,
              gameId: f.gameId,
              text: describeFrame(f),
            },
            ...state.feed,
          ].slice(0, MAX_FEED),
        };
      }

      if (f.type === 'round_settled') {
        const prev = state.tables[f.tableId] ?? emptyTable(f.tableId, f.gameId);
        return {
          ...state,
          tables: {
            ...state.tables,
            [f.tableId]: {
              ...prev,
              gameId: f.gameId,
              status: 'settled',
              lastResult: f,
              view: { ...prev.view, revealed: true, settled: true },
              history: [
                {
                  roundId: f.roundId,
                  walletId: f.walletId,
                  betCents: prev.betCents,
                  payoutCents: f.payoutCents,
                  netCents: f.netCents,
                  at: now,
                },
                ...prev.history,
              ].slice(0, MAX_HISTORY_PER_TABLE),
            },
          },
          feed: [
            {
              id: uid,
              kind: 'settled' as const,
              at: now,
              tableId: f.tableId,
              gameId: f.gameId,
              text: describeFrame(f),
              netCents: f.netCents,
            },
            ...state.feed,
          ].slice(0, MAX_FEED),
        };
      }

      return state;
    }

    default:
      return state;
  }
}
