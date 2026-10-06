-- ════════════════════════════════════════════════════════════════
-- 001_init.sql —— AI 游乐场初始 schema
--
-- 铁律：所有金额字段一律 INTEGER，单位「分」。禁止浮点。
--       任何余额变动必须经由 transactions 留痕，不允许裸 UPDATE 余额。
-- ════════════════════════════════════════════════════════════════

PRAGMA foreign_keys = ON;

-- ── 桌台：前端大厅与多屏观察台按 table_id 订阅 ────────────────────
CREATE TABLE tables (
  id         TEXT    PRIMARY KEY,
  game_id    TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  seats      INTEGER NOT NULL DEFAULT 1,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── 钱包：所有 AI / 人类 / 庄家共用同一套账本 ─────────────────────
CREATE TABLE wallets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type    TEXT    NOT NULL CHECK (owner_type IN ('agent','human','house','system')),
  owner_id      TEXT    NOT NULL,
  display_name  TEXT    NOT NULL,
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_type, owner_id)
);

-- ── 对局 ──────────────────────────────────────────────────────────
-- status = 'awaiting_action' 是「服务端会等人」的状态：
--   局面挂起，等托管循环或外部 agent 提交动作，超时由 turn_timeout_ms 兜底。
CREATE TABLE rounds (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id      TEXT    NOT NULL,
  table_id     TEXT    NOT NULL,
  wallet_id    INTEGER NOT NULL REFERENCES wallets(id),
  bet_cents    INTEGER NOT NULL CHECK (bet_cents > 0),
  seed_commit  TEXT    NOT NULL,          -- 开局前公开：sha256(server_seed)
  server_seed  TEXT    NOT NULL,          -- 库里全程存在（推进局面要用），但 API 只在结算后才吐出去
  client_seed  TEXT    NOT NULL,
  nonce        INTEGER NOT NULL,
  state        TEXT    NOT NULL DEFAULT '{}',
  status       TEXT    NOT NULL CHECK (status IN ('awaiting_action','settled','cancelled','timed_out')),
  payout_cents INTEGER NOT NULL DEFAULT 0,
  net_cents    INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  settled_at   TEXT
);
CREATE INDEX idx_rounds_wallet   ON rounds(wallet_id, id DESC);
CREATE INDEX idx_rounds_status   ON rounds(status);
CREATE INDEX idx_rounds_table    ON rounds(table_id, id DESC);

-- ── 流水账本：只增不改 ────────────────────────────────────────────
CREATE TABLE transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_id     INTEGER NOT NULL REFERENCES wallets(id),
  round_id      INTEGER REFERENCES rounds(id),
  kind          TEXT    NOT NULL CHECK (kind IN ('grant','bet','payout','refund','relief','transfer')),
  delta_cents   INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  idem_key      TEXT    UNIQUE,           -- 幂等键：防重复下注 / 网络重试
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tx_wallet_time ON transactions(wallet_id, id DESC);
CREATE INDEX idx_tx_round       ON transactions(round_id);

-- ── 逐帧事件：前端动画与回放的唯一数据源 ──────────────────────────
CREATE TABLE round_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  seq      INTEGER NOT NULL,
  actor    TEXT    NOT NULL,
  type     TEXT    NOT NULL,
  payload  TEXT    NOT NULL DEFAULT '{}',
  at_ms    INTEGER NOT NULL,
  UNIQUE (round_id, seq)
);
CREATE INDEX idx_events_round ON round_events(round_id, seq);

-- ── AI 选手 ───────────────────────────────────────────────────────
-- kind: llm         = 服务端托管的 LLM 循环
--       scripted    = 内置策略脚本
--       mcp-agent   = 外部 agent 通过 MCP 自己驱动，服务端「等人」
CREATE TABLE agent_runners (
  id              TEXT    PRIMARY KEY,
  display_name    TEXT    NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('llm','scripted','mcp-agent')),
  provider        TEXT,
  model           TEXT,
  base_url        TEXT,
  api_key_env     TEXT,                   -- 只存环境变量名，绝不存密钥本体
  system_prompt   TEXT,
  strategy        TEXT,
  bankroll_cents  INTEGER NOT NULL,
  pace_ms         INTEGER NOT NULL DEFAULT 1500,
  turn_timeout_ms INTEGER NOT NULL DEFAULT 60000,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── 「看 AI 怎么玩」的核心表：每次决策的输入与输出都留档 ──────────
CREATE TABLE agent_decisions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  runner_id    TEXT    NOT NULL REFERENCES agent_runners(id),
  round_id     INTEGER REFERENCES rounds(id),
  game_id      TEXT    NOT NULL,
  prompt       TEXT    NOT NULL,
  raw_response TEXT,
  action       TEXT,
  reasoning    TEXT,                      -- AI 自述的「我为什么这么打」
  latency_ms   INTEGER,
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  error        TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_decisions_runner ON agent_decisions(runner_id, id DESC);
CREATE INDEX idx_decisions_round  ON agent_decisions(round_id);

-- ── 游戏配置：开关、注额上下限、娱乐性 house edge ─────────────────
CREATE TABLE game_configs (
  game_id       TEXT    PRIMARY KEY,
  enabled       INTEGER NOT NULL DEFAULT 1,
  min_bet_cents INTEGER NOT NULL DEFAULT 100,
  max_bet_cents INTEGER NOT NULL DEFAULT 100000,
  house_edge_bp INTEGER NOT NULL DEFAULT 0,   -- 万分之一，仅娱乐参数
  params_json   TEXT    NOT NULL DEFAULT '{}'
);

-- ── 排行榜快照：用于画余额曲线 ────────────────────────────────────
CREATE TABLE leaderboard_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_id     INTEGER NOT NULL REFERENCES wallets(id),
  balance_cents INTEGER NOT NULL,
  net_cents     INTEGER NOT NULL,
  taken_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_snapshots_wallet ON leaderboard_snapshots(wallet_id, id DESC);
