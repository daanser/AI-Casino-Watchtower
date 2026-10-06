/**
 * @ai-gaming/shared —— 前后端共用的类型与协议
 *
 * 铁律：所有金额一律用整数「分」(Cents)。永远不要出现浮点数。
 *      1 筹码 (coin) = 100 分。
 */

/** 金额，单位：分。整数。 */
export type Cents = number;

/** 1 筹码 = 100 分 */
export const CENTS_PER_COIN = 100;

export const coins = (n: number): Cents => Math.round(n * CENTS_PER_COIN);
export const toCoins = (c: Cents): number => c / CENTS_PER_COIN;
/** 展示用：把「分」格式化成人类可读的筹码数 */
export const fmtCoins = (c: Cents): string =>
  (c / CENTS_PER_COIN).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

// ─────────────────────────────────────────────────────────────
// 游戏
// ─────────────────────────────────────────────────────────────

export const GAME_IDS = [
  'slots',
  'roulette',
  'crash',
  'blackjack',
  'baccarat',
  'sicbo',
  'holdem',
  'video-poker',
  'dragon-tiger',
  'wheel',
  'plinko',
  'craps',
  'keno',
  'hi-lo',
] as const;

export type GameId = (typeof GAME_IDS)[number];

/** 游戏节奏：一把结算 / 实时推进 / 回合制等待玩家 */
export type PacingMode = 'instant' | 'realtime' | 'turnbased';

export interface GameMeta {
  id: GameId;
  name: string;
  /** 一句话规则摘要，给 AI 看的 */
  description: string;
  minBetCents: Cents;
  maxBetCents: Cents;
  /** 合法动作名，用于校验 AI 提交的动作 */
  actions: string[];
  pacing: PacingMode;
}

// ─────────────────────────────────────────────────────────────
// 玩家
// ─────────────────────────────────────────────────────────────

/** 三种驱动模式，服务端对它们一视同仁 */
export type AgentKind = 'llm' | 'scripted' | 'mcp-agent';

export type WalletOwnerType = 'agent' | 'human' | 'house' | 'system';

// ─────────────────────────────────────────────────────────────
// 对局
// ─────────────────────────────────────────────────────────────

/**
 * awaiting_action —— 局面挂起，等服务端托管循环或外部 agent 提交动作
 *                    这是「服务端会等人」的状态，不是阻塞
 * timed_out       —— 超过 turn_timeout_ms 没动作，已自动兜底
 */
export type RoundStatus = 'awaiting_action' | 'settled' | 'cancelled' | 'timed_out';

export type TxKind = 'grant' | 'bet' | 'payout' | 'refund' | 'relief' | 'transfer';

export interface WalletRow {
  id: number;
  owner_type: WalletOwnerType;
  owner_id: string;
  display_name: string;
  balance_cents: Cents;
  created_at: string;
}

export interface TransactionRow {
  id: number;
  wallet_id: number;
  round_id: number | null;
  kind: TxKind;
  delta_cents: Cents;
  balance_after: Cents;
  idem_key: string | null;
  created_at: string;
}

export interface RoundRow {
  id: number;
  game_id: GameId;
  table_id: string;
  wallet_id: number;
  bet_cents: Cents;
  seed_commit: string;
  server_seed: string | null;
  client_seed: string;
  nonce: number;
  state: string;
  status: RoundStatus;
  payout_cents: Cents;
  net_cents: Cents;
  started_at: string;
  settled_at: string | null;
}

export interface RoundEventRow {
  id: number;
  round_id: number;
  seq: number;
  actor: string;
  type: string;
  payload: string;
  at_ms: number;
}

// ─────────────────────────────────────────────────────────────
// WebSocket 消息协议
// ─────────────────────────────────────────────────────────────

/** 一帧游戏事件。前端按 atMs 在虚拟时钟上播放，实时观看与回放走同一条代码路径。 */
export interface RoundEventFrame {
  type: 'round_event';
  roundId: number;
  tableId: string;
  gameId: GameId;
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
  gameId: GameId;
  walletId: number;
  betCents: Cents;
  /** 已过滤的局面，不含暗牌 / 崩溃点 / 未揭示种子 */
  view: Record<string, unknown>;
  seedCommit: string;
  atMs: number;
}

export interface RoundSettledFrame {
  type: 'round_settled';
  roundId: number;
  tableId: string;
  gameId: GameId;
  walletId: number;
  status: RoundStatus;
  payoutCents: Cents;
  netCents: Cents;
  balanceAfter: Cents;
  /** 结算后才揭示，供前端验证 */
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

/** 「我为什么这么打」—— AI 的自述理由，实时推给前端 */
export interface ReasoningFrame {
  type: 'reasoning';
  roundId: number;
  tableId: string;
  actor: string;
  gameId: GameId;
  text: string;
  atMs: number;
}

/** bot 主动切换游戏时推送：原因、人类可见的起止游戏名与明确提示 */
export interface GameSwitchFrame {
  type: 'game_switch';
  botId: string;
  displayName: string;
  tableId: string;
  fromGameId: GameId;
  toGameId: GameId;
  reason: string;
  atMs: number;
}

export interface HelloFrame {
  type: 'hello';
  serverTime: string;
  tables: string[];
}

export type ServerFrame =
  | RoundEventFrame
  | RoundStartedFrame
  | RoundSettledFrame
  | WalletFrame
  | ReasoningFrame
  | GameSwitchFrame
  | HelloFrame;

// ─────────────────────────────────────────────────────────────
// 错误
// ─────────────────────────────────────────────────────────────

export type ErrorCode =
  | 'WALLET_NOT_FOUND'
  | 'INSUFFICIENT_FUNDS'
  | 'GAME_NOT_FOUND'
  | 'GAME_DISABLED'
  | 'BET_OUT_OF_RANGE'
  | 'ROUND_NOT_FOUND'
  | 'ROUND_NOT_OPEN'
  | 'INVALID_ACTION'
  | 'DUPLICATE_ACTION'
  | 'INTERNAL';

export class PlaygroundError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string, status = 400) {
    super(message);
    this.name = 'PlaygroundError';
    this.code = code;
    this.status = status;
  }
}
