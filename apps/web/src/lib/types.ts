/**
 * 前端自己的一份协议类型。
 *
 * 刻意不从 @ai-gaming/shared 直接引：那是给 Node 端的 TS 源码，
 * 让 Vite 去转译 workspace 里的裸 TS 会引入不必要的构建配置。
 * 这些类型是纯声明，重复一份没有运行时风险。
 */

export type Cents = number;

// ── 游戏 ─────────────────────────────────────────────────────

export type PacingMode = 'instant' | 'realtime' | 'turnbased';

export interface GameMeta {
  id: string;
  name: string;
  description: string;
  minBetCents: Cents;
  maxBetCents: Cents;
  actions: string[];
  pacing: PacingMode;
  enabled: boolean;
}

// ── 钱包 / 玩家 ──────────────────────────────────────────────

export interface WalletRow {
  id: number;
  owner_type: string;
  owner_id: string;
  display_name: string;
  balance_cents: Cents;
  created_at: string;
}

export interface BotStatus {
  id: string;
  displayName: string;
  persona: string;
  gameId: string;
  tableId: string;
  walletId: number;
  running: boolean;
  rounds: number;
  wins: number;
  netCents: Cents;
  lastReasoning: string | null;
}

// ── 对局 ─────────────────────────────────────────────────────

export type RoundStatus = 'awaiting_action' | 'settled' | 'cancelled' | 'timed_out';

export interface PublicRound {
  id: number;
  gameId: string;
  tableId: string;
  walletId: number;
  betCents: Cents;
  status: RoundStatus;
  payoutCents: Cents;
  netCents: Cents;
  seedCommit: string;
  serverSeed: string | null;
  clientSeed: string;
  nonce: number;
  startedAt: string;
  settledAt: string | null;
  view: Record<string, unknown>;
}

export interface RoundEvent {
  seq: number;
  actor: string;
  type: string;
  payload: Record<string, unknown>;
  atMs: number;
}

export interface TableSummary {
  tableId: string;
  gameId: string;
  players: number;
  lastActivity: string | null;
  openRounds: number;
}

// ── WebSocket 帧 ─────────────────────────────────────────────

export interface RoundEventFrame {
  type: 'round_event';
  roundId: number;
  tableId: string;
  gameId: string;
  seq: number;
  actor: string;
  eventType: string;
  payload: Record<string, unknown>;
  atMs: number;
}

export interface RoundStartedFrame {
  type: 'round_started';
  roundId: number;
  tableId: string;
  gameId: string;
  walletId: number;
  betCents: Cents;
  view: Record<string, unknown>;
  seedCommit: string;
  atMs: number;
}

export interface RoundSettledFrame {
  type: 'round_settled';
  roundId: number;
  tableId: string;
  gameId: string;
  walletId: number;
  status: RoundStatus;
  payoutCents: Cents;
  netCents: Cents;
  balanceAfter: Cents;
  serverSeed: string;
  breakdown: Record<string, unknown>;
  atMs: number;
}

export interface WalletFrame {
  type: 'wallet_update';
  walletId: number;
  balanceCents: Cents;
  deltaCents: Cents;
  reason: string;
  atMs: number;
}

export interface ReasoningFrame {
  type: 'reasoning';
  roundId: number;
  tableId: string;
  actor: string;
  gameId: string;
  text: string;
  atMs: number;
}

/** 握手帧。**故意不带桌位清单** —— 桌位只来自 snapshot.bots 与实时帧，详见 shared 里的说明。 */
export interface HelloFrame {
  type: 'hello';
  serverTime: string;
}

export interface GameSwitchFrame {
  type: 'game_switch';
  botId: string;
  displayName: string;
  tableId: string;
  fromGameId: string;
  toGameId: string;
  reason: string;
  atMs: number;
}

/**
 * 服务端帧 + 两个前端自己贴上的元数据。
 * `_uid` / `_at` 由 WebSocket 回调在 dispatch 之前写好 —— 这样 reducer 保持纯函数，
 * React 严格模式下被重复调用也不会产生重复的列表项。
 */
export interface FrameMeta {
  _uid: string;
  _at: number;
}

export type ServerFrame =
  | RoundEventFrame
  | RoundStartedFrame
  | RoundSettledFrame
  | WalletFrame
  | ReasoningFrame
  | HelloFrame
  | GameSwitchFrame;

export type MetaFrame = ServerFrame & Partial<FrameMeta>;

// ── 各游戏的局面快照（publicView 的形状）─────────────────────

export interface Card {
  rank: string;
  suit: string;
}

export interface BjView {
  revealed: boolean;
  finished: boolean;
  doubled: boolean;
  player: Card[];
  playerTotal: number;
  playerSoft: boolean;
  playerBlackjack: boolean;
  dealer: Card[];
  dealerTotal: number | null;
  actions: string[];
}

export interface RouletteView {
  bet?: string;
  revealed: boolean;
  winning?: number;
  color?: 'red' | 'black' | 'green';
}

export interface SlotsView {
  revealed: boolean;
  reels?: number[];
  multiplier?: number;
  labels?: string[];
}

export interface DtCard {
  rank: number;
  label: string;
  suit: string;
}

export interface DragonTigerView {
  bet?: string;
  revealed: boolean;
  dragon?: DtCard;
  tiger?: DtCard;
  winner?: 'dragon' | 'tiger' | 'tie';
  multiplier?: number;
}

export interface CrashView {
  revealed: boolean;
  growthHalfLifeMs?: number;
  crashPoint?: number;
  cashoutAtMs?: number | null;
  multiplier?: number | null;
  busted?: boolean;
}

// ── 桌台运行时状态 ───────────────────────────────────────────

export interface LiveFrame {
  seq: number;
  eventType: string;
  payload: Record<string, unknown>;
  atMs: number;
  actor: string;
}

export interface SettledRecord {
  roundId: number;
  walletId: number;
  betCents: Cents;
  payoutCents: Cents;
  netCents: Cents;
  at: number;
}

export interface TableRuntime {
  tableId: string;
  gameId: string;
  roundId: number | null;
  walletId: number | null;
  betCents: Cents;
  status: 'idle' | 'running' | 'settled';
  /** 从 round_started 拿到的初始 view，逐帧叠加后作为当前画面 */
  view: Record<string, unknown>;
  /** 当前局已经播过的帧（用于回放 / 牌面累积） */
  frames: LiveFrame[];
  /** 结算后的结果 */
  lastResult: RoundSettledFrame | null;
  /** 该桌最近几局的净收益，画迷你走势 */
  history: SettledRecord[];
  /** 最后一次推理 */
  reasoning: { actor: string; text: string; at: number } | null;
  gameSwitch?: { fromGameId: string; toGameId: string; reason: string; at: number };
  /** 服务端发来的 startAt（本地时钟） */
  startedAt: number;
}

export interface FeedItem {
  id: string;
  kind: 'start' | 'event' | 'settled' | 'wallet' | 'switch';
  at: number;
  tableId: string;
  gameId: string;
  text: string;
  netCents?: Cents;
}

export interface ReasoningItem {
  id: string;
  at: number;
  tableId: string;
  gameId: string;
  actor: string;
  text: string;
  roundId: number;
}

export interface PlaygroundSnapshot {
  wallets: WalletRow[];
  tables: TableSummary[];
  games: GameMeta[];
  bots: BotStatus[];
  recentRounds: PublicRound[];
  reconcile: { walletId: number; displayName: string; balanceCents: Cents; ok: boolean }[];
}
