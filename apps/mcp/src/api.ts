/**
 * 与游乐场主服务通信的薄客户端。
 *
 * 为什么不让 MCP Server 直接开库？
 * ─ 因为主服务进程里那把 WriteLock 是「进程内」的锁。如果 MCP 另开一个进程
 *   直接写同一个 SQLite，两个进程各自持锁、互相看不见，钱包就可能算错账。
 *   所以 MCP 一律走 HTTP 调主服务，让「唯一写者」这件事始终成立。
 */

import WebSocket from 'ws';

export interface ApiClientOptions {
  baseUrl: string;
  /** 单次请求超时（毫秒） */
  timeoutMs?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`[${status}] ${code}: ${message}`);
    this.name = 'ApiError';
  }
}

export class PlaygroundApi {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  get endpoint() {
    return this.baseUrl;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
      const text = await res.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      if (!res.ok) {
        const e = (body ?? {}) as { error?: string; message?: string };
        throw new ApiError(res.status, e.error ?? 'HTTP_ERROR', e.message ?? String(text));
      }
      return body as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private get<T>(path: string) {
    return this.request<T>(path, { method: 'GET' });
  }

  private post<T>(path: string, body?: unknown) {
    return this.request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  // ── 元信息 ───────────────────────────────────────────────────

  health() {
    return this.get<{ ok: boolean; service: string; games: number; bots: number }>(
      '/api/v1/health',
    );
  }

  games() {
    return this.get<GameInfo[]>('/api/v1/games');
  }

  gameRules(id: string) {
    return this.get<{ id: string; name: string; description: string; actions: string[] }>(
      `/api/v1/games/${encodeURIComponent(id)}/rules`,
    );
  }

  state() {
    return this.get<PlaygroundState>('/api/v1/state');
  }

  bots() {
    return this.get<BotStatus[]>('/api/v1/bots');
  }

  tables() {
    return this.get<TableSummary[]>('/api/v1/tables');
  }

  reconcile() {
    return this.get<ReconcileReport>('/api/v1/reconcile');
  }

  // ── 钱包 ─────────────────────────────────────────────────────

  wallets() {
    return this.get<WalletRow[]>('/api/v1/wallets');
  }

  wallet(id: number) {
    return this.get<{
      wallet: WalletRow;
      transactions: TransactionRow[];
      reconcile: { walletId: number; balanceCents: number; ledgerSumCents: number; ok: boolean };
    }>(`/api/v1/wallets/${id}`);
  }

  createWallet(input: {
    ownerId: string;
    displayName: string;
    ownerType?: string;
    initialCents?: number;
  }) {
    return this.post<WalletRow>('/api/v1/wallets', input);
  }

  grant(walletId: number, cents: number, reason?: string) {
    return this.post<{ wallet: WalletRow; tx: TransactionRow }>(
      `/api/v1/wallets/${walletId}/grant`,
      { cents, reason },
    );
  }

  // ── 对局 ─────────────────────────────────────────────────────

  rounds(limit = 30, walletId?: number) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (walletId !== undefined) q.set('walletId', String(walletId));
    return this.get<PublicRound[]>(`/api/v1/rounds?${q}`);
  }

  startRound(input: {
    walletId: number;
    gameId: string;
    betCents: number;
    params?: Record<string, unknown>;
    clientSeed?: string;
    tableId?: string;
    actor?: string;
    reasoning?: string;
  }) {
    return this.post<PublicRound>('/api/v1/rounds', input);
  }

  round(id: number) {
    return this.get<PublicRound>(`/api/v1/rounds/${id}`);
  }

  events(roundId: number) {
    return this.get<RoundEvent[]>(`/api/v1/rounds/${roundId}/events`);
  }

  verify(roundId: number) {
    return this.get<{
      roundId: number;
      gameId: string;
      commit: string;
      serverSeed: string;
      clientSeed: string;
      nonce: number;
      ok: boolean;
    }>(`/api/v1/rounds/${roundId}/verify`);
  }

  /**
   * 提交动作。reasoning 就是「我为什么这么打」——
   * 会落成一帧事件，实时推给所有观察窗口。
   */
  act(
    roundId: number,
    action: { type: string; [k: string]: unknown },
    opts: { reasoning?: string; actor?: string } = {},
  ) {
    return this.post<{
      round: PublicRound;
      balanceAfter: number;
      settled: boolean;
    }>(`/api/v1/rounds/${roundId}/action`, {
      action,
      reasoning: opts.reasoning,
      actor: opts.actor,
    });
  }

  // ── 围观：抓一段实时帧 ────────────────────────────────────────

  /**
   * 连上 WS 收集若干毫秒的广播帧，然后断开。
   * 这样外部 agent 也能「看」到别人（脚本 Bot、其他 AI）正在怎么打。
   */
  watch(ms = 2000, tableFilter?: string): Promise<WatchResult> {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';
    return new Promise<WatchResult>((resolve, reject) => {
      const frames: ServerFrame[] = [];
      const socket = new WebSocket(wsUrl);
      let settled = false;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        if (err) reject(err);
        else resolve({ ms, frames });
      };

      const timer = setTimeout(() => finish(), ms);

      socket.on('message', (raw) => {
        try {
          const frame = JSON.parse(String(raw)) as ServerFrame;
          if (tableFilter && 'tableId' in frame && frame.tableId !== tableFilter) return;
          frames.push(frame);
        } catch {
          /* 忽略解析不了的帧 */
        }
      });
      socket.on('error', (err) => {
        clearTimeout(timer);
        finish(err as Error);
      });
      socket.on('close', () => {
        clearTimeout(timer);
        finish();
      });
    });
  }
}

// ─────────────────────────────────────────────────────────────
// 从主服务拿到的数据形状（只声明 MCP 用得到的字段）
// ─────────────────────────────────────────────────────────────

export interface GameInfo {
  id: string;
  name: string;
  description: string;
  minBetCents: number;
  maxBetCents: number;
  actions: string[];
  pacing: 'instant' | 'realtime' | 'turnbased';
  enabled: boolean;
}

export interface WalletRow {
  id: number;
  owner_type: string;
  owner_id: string;
  display_name: string;
  balance_cents: number;
  created_at: string;
}

export interface TransactionRow {
  id: number;
  wallet_id: number;
  round_id: number | null;
  kind: string;
  delta_cents: number;
  balance_after: number;
  idem_key: string | null;
  created_at: string;
}

export interface PublicRound {
  id: number;
  gameId: string;
  tableId: string;
  walletId: number;
  betCents: number;
  status: string;
  payoutCents: number;
  netCents: number;
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

export interface BotStatus {
  id: string;
  name: string;
  persona: string;
  gameId: string;
  walletId: number;
  running: boolean;
  roundsPlayed: number;
  balanceCents: number;
  lastAction?: string;
}

export interface ReconcileReport {
  ok: boolean;
  checked: number;
  results: {
    walletId: number;
    displayName: string;
    balanceCents: number;
    ledgerSumCents: number;
    diffCents: number;
    ok: boolean;
  }[];
}

export interface PlaygroundState {
  wallets: WalletRow[];
  tables: TableSummary[];
  games: { id: string; name: string }[];
  bots: BotStatus[];
  recentRounds: PublicRound[];
  reconcile: ReconcileReport['results'];
}

export interface ServerFrame {
  type: string;
  tableId?: string;
  roundId?: number;
  gameId?: string;
  [k: string]: unknown;
}

export interface WatchResult {
  ms: number;
  frames: ServerFrame[];
}
