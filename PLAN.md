# AI 游乐场（AI Playground）实施方案

> 一个让多个 AI 智能体在同一个赌场里玩 14 种赌桌游戏的系统。
> 所有 AI 共用一个 SQLite 钱包账本，人类从前端**围观 AI 怎么玩**（实时动画 + 决策日志 + 回放）。

---

## 0. 一句话定位与边界

**是什么**：一个「AI 赌场观察台」。AI 通过 MCP / REST 接口下注、决策、结算；前端把每一步实时演出来，并且能展开看 AI 当时的提示词和它给出的理由。

**明确不是**：不涉及任何真实货币、不充值、不提现、不可兑换任何有价值的物品。筹码是纯虚拟积分，house edge 只是娱乐参数。这一点要写进 README 首页和前端页脚。

**v1 非目标**：真人玩家对战、移动端 App、多机房部署、真钱通道。

---

## 1. 技术选型（已按本机环境实测确认）

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js 22.22.2（本机 managed 版） | 已装，服务端 / MCP / 前端同一语言 |
| 包管理 | npm workspaces | 本机 pnpm 挂在 nvm node24 下，与 managed node22 有版本耦合风险，npm 更稳 |
| 后端框架 | Fastify | 原生 WebSocket 支持、schema 校验、性能好 |
| 数据库 | **Node 内置 `node:sqlite`**（WAL 模式） | 实测 Node 22.22 **不加 flag 就能用**，**零原生依赖**——不用编译 better-sqlite3，也不用担心 ABI 不匹配 |
| 迁移 | 手写 SQL 文件 + 极简执行器 | 迁移就是可读的 `.sql`，没有 codegen 步骤，出问题一眼能看明白 |
| MCP | `@modelcontextprotocol/sdk` | AI 调用的官方入口 |
| 前端 | Vite + React 18 + TypeScript + Tailwind | 动画生态最全 |
| 前端数据 | TanStack Query（REST）+ 原生 WS 客户端 | 请求缓存 + 实时推送分离 |
| 图表 | Recharts（余额曲线）+ Canvas/SVG 手写游戏动画 | 游戏动画用现成库会失真 |
| 部署 | 本地 `npm run dev` 起步，后续可 Docker / 静态发布 | 先跑起来再说 |

**金额一律用整数「分」（`*_cents`）**，禁止浮点。这是赌场类系统最容易翻车的地方，写进代码规范。

---

## 2. 系统架构

```
┌───────────────────────────────────────────────────────────┐
│  AI 玩家层                                                 │
│  LLM Agent Runner ×N（硅基流动/OpenAI/本地）  脚本 Bot ×N    │
└───────────────┬───────────────────────┬───────────────────┘
                │ MCP (stdio/SSE)       │ REST
┌───────────────▼───────────────────────▼───────────────────┐
│  接入层                                                    │
│  MCP Server   │   REST API (/api/v1)   │  WebSocket (/ws)  │
└───────────────┬───────────────────────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────┐
│  核心层（apps/server）                                     │
│  游戏引擎（14 个游戏模块，纯函数 + 注入式 RNG）              │
│  钱包与账本服务（事务 + 幂等键）                            │
│  事件总线（每个动作产生有序事件，同时写库 + 广播 WS）        │
│  公平性模块（种子承诺 / 揭示，可回放）                       │
└───────────────┬───────────────────────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────┐
│  存储层  SQLite（WAL）  wallets / transactions / rounds ... │
└───────────────────────────────────────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────┐
│  展示层（apps/web）  大厅 · 桌台动画 · AI 档案 · 排行榜 · 回放 │
└───────────────────────────────────────────────────────────┘
```

**关键数据流（一次下注的生命周期）**：

1. AI 调 `pg_start_round` → 服务端开一局，生成 `server_seed`，公开 `seed_commit`（哈希），扣筹码写一条 `bet` 流水
2. AI 调 `pg_act` / `pg_cashout` 若干次 → 每次返回**该 AI 可见的局面**（不含庄家暗牌、不含崩溃点）
3. 结算 → 写 `payout` 流水 + `round_events` 全序列 + 揭示 `server_seed`
4. 每一步都同时广播到 WebSocket → 前端按 `at_ms` 时间轴**慢慢演**

> 注意：服务端是瞬间算完的，前端是「按事件时间轴重放」。这样游戏逻辑不需要考虑动画，前端也不需要猜。

---

## 3. 目录结构

```
ai-gaming/
├─ PLAN.md
├─ package.json                     # npm workspaces 根
├─ tsconfig.json
├─ data/playground.db               # SQLite 文件（gitignore）
├─ packages/
│  ├─ shared/src/index.ts           # 前后端共用类型 + WS 事件协议
│  ├─ db/
│  │  ├─ migrations/001_init.sql    # 全部表结构（可读的 SQL）
│  │  └─ src/index.ts               # 连接 / WAL / 迁移 / 事务
│  └─ core/                         # 无 HTTP 依赖，可单独单测
│     ├─ src/rng.ts                 # 可播种 RNG（HMAC-SHA256，含无偏取样）
│     ├─ src/fairness.ts            # 承诺-揭示
│     ├─ src/wallet.ts              # 账本（唯一余额变动入口）
│     ├─ src/events.ts              # 事件总线
│     ├─ src/engine.ts              # 回合编排 + 单写者锁
│     └─ src/games/                 # 游戏模块（types / roulette / index）
├─ apps/
│  ├─ server/src/app.ts             # Fastify：REST + WS
│  ├─ server/src/index.ts           # 入口
│  ├─ mcp/                          # 待建：MCP Server（P3）
│  ├─ agents/                       # 待建：AI 运行时（P3）
│  └─ web/                          # 待建：多屏观察台（P4）
└─ scripts/smoke.ts                 # 端到端冒烟验证
```

### 3.1 怎么跑起来

```bash
npm install          # 装依赖
npm run migrate      # 建库（幂等，重复跑没事）
npm test             # 单元测试：RNG + 账本 + 三个游戏的 RTP
npm run smoke        # 端到端：三桌并行 → 对账 → 验签 → 确认 WS 事件
npm run dev          # 起服务 + 放 3 个脚本 Bot 上场 → 打开 http://127.0.0.1:5173/
npm run typecheck    # 类型检查
```

环境变量：`DEMO=0` 不放 Bot 上场 · `SPEED=0.25` 五倍速 · `PORT=xxxx` 换端口

**现在打开 http://127.0.0.1:5173/ 就能看到三个 AI 在三张桌上同时玩**（老虎机 / 龙虎斗 / 轮盘），
每桌下方实时显示它这一把的「我为什么这么打」。这是 P4 的**单文件简化版**，
正经的多屏观察台（拖拽换位、弹出独立窗口、AI 档案、回放）还没做。



---

## 4. 数据库设计

### 4.1 钱包与账本

```sql
CREATE TABLE wallets (
  id            INTEGER PRIMARY KEY,
  owner_type    TEXT NOT NULL CHECK (owner_type IN ('agent','human','house','system')),
  owner_id      TEXT NOT NULL,                    -- 对应 agent_runners.id / 'house'
  display_name  TEXT NOT NULL,
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_type, owner_id)
);

-- 只增不改的流水账本，任何余额变动必须在此留痕
CREATE TABLE transactions (
  id            INTEGER PRIMARY KEY,
  wallet_id     INTEGER NOT NULL REFERENCES wallets(id),
  round_id      INTEGER REFERENCES rounds(id),
  kind          TEXT NOT NULL,      -- grant|bet|payout|refund|relief|transfer
  delta_cents   INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,   -- 冗余存一份，便于对账
  idem_key      TEXT UNIQUE,        -- 幂等键：防重复下注 / 网络重试
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tx_wallet_time ON transactions(wallet_id, created_at DESC);
```

**账本三条铁律**：
1. 余额只能通过 `transactions` 变动，不允许直接 UPDATE 余额。
2. 单局「下注 + 结算」必须在一个 SQLite 事务里完成，要么都成功要么都回滚。
3. 每次下注带幂等键（`round_id + action_seq`），网络重试不会重复扣钱。

### 4.2 对局与事件

```sql
CREATE TABLE rounds (
  id           INTEGER PRIMARY KEY,
  game_id      TEXT NOT NULL,
  table_id     TEXT NOT NULL,
  wallet_id    INTEGER NOT NULL REFERENCES wallets(id),
  bet_cents    INTEGER NOT NULL,
  seed_commit  TEXT NOT NULL,      -- 开局前公开：sha256(server_seed)
  server_seed  TEXT,               -- 结算后揭示，用于验证
  client_seed  TEXT NOT NULL,      -- AI 自己提供的种子
  nonce        INTEGER NOT NULL,   -- 同一 AI 的第几局
  state        TEXT NOT NULL,      -- JSON：完整局面（服务端真相）
  status       TEXT NOT NULL,      -- awaiting_action|settled|cancelled|timed_out
  payout_cents INTEGER NOT NULL DEFAULT 0,
  net_cents    INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at   TEXT
);

-- 逐帧事件，前端动画与回放的唯一数据源
CREATE TABLE round_events (
  id       INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  seq      INTEGER NOT NULL,
  actor    TEXT NOT NULL,          -- agent id / 'dealer' / 'system'
  type     TEXT NOT NULL,          -- deal|hit|stand|spin|tick|crash|cashout|settle
  payload  TEXT NOT NULL,          -- JSON
  at_ms    INTEGER NOT NULL        -- 相对开局的毫秒偏移（虚拟时钟）
);
CREATE INDEX idx_events_round ON round_events(round_id, seq);
```

### 4.3 AI 选手与决策日志

```sql
CREATE TABLE agent_runners (
  id             TEXT PRIMARY KEY,   -- 'siliconflow-qwen-01'
  display_name   TEXT NOT NULL,
  kind           TEXT NOT NULL,      -- llm | scripted | mcp-agent（外部 agent 自驱）
  provider       TEXT,               -- siliconflow|openai|local
  model          TEXT,
  base_url       TEXT,
  api_key_env    TEXT,               -- 只存环境变量名，绝不存密钥本体
  system_prompt  TEXT,
  strategy       TEXT,               -- 脚本策略名，如 'martingale-red'
  bankroll_cents INTEGER NOT NULL,
  pace_ms        INTEGER NOT NULL DEFAULT 1500,  -- 托管循环的思考节奏
  turn_timeout_ms INTEGER NOT NULL DEFAULT 60000, -- 外部 agent 超时兜底（mcp-agent 用）
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 「看 AI 怎么玩」的核心表：每次决策的输入与输出都留档
CREATE TABLE agent_decisions (
  id           INTEGER PRIMARY KEY,
  runner_id    TEXT NOT NULL REFERENCES agent_runners(id),
  round_id     INTEGER REFERENCES rounds(id),
  game_id      TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  raw_response TEXT,
  action       TEXT,               -- 解析后的结构化动作
  reasoning    TEXT,               -- AI 自述理由（前端直接展示）
  latency_ms   INTEGER,
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_decisions_runner ON agent_decisions(runner_id, created_at DESC);
```

### 4.4 其余辅助表

```sql
CREATE TABLE game_configs (      -- 可热改：开关、注额上下限、娱乐性 house edge
  game_id       TEXT PRIMARY KEY,
  enabled       INTEGER NOT NULL DEFAULT 1,
  min_bet_cents INTEGER NOT NULL DEFAULT 100,
  max_bet_cents INTEGER NOT NULL DEFAULT 1000000,
  house_edge_bp INTEGER NOT NULL DEFAULT 0,   -- 万分之一，仅娱乐参数
  params_json   TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE leaderboard_snapshots (  -- 定时快照，用于画余额曲线
  id          INTEGER PRIMARY KEY,
  wallet_id   INTEGER NOT NULL REFERENCES wallets(id),
  balance_cents INTEGER NOT NULL,
  net_cents   INTEGER NOT NULL,
  taken_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 5. 游戏清单（14 个，超出「至少 10 个」的要求）

| # | 中文名 | game_id | 玩法要点 | 决策类型 | 优先级 |
|---|---|---|---|---|---|
| 1 | 老虎机 | `slots` | 5 轴 3 行，赔率表可配 | 一把结算 | ✅ P1 |
| 2 | 欧式轮盘 | `roulette` | 单零 37 格，多种押注位 | 一把结算 | ✅ P1 |
| 3 | 大火箭 | `crash` | 乘数实时上涨，崩前主动收 | 实时收手 | ✅ P1 |
| 4 | 黑杰克 | `blackjack` | 21 点，要牌/停牌/加倍/分牌 | 多步回合制 | ✅ P1 |
| 5 | 百家乐 | `baccarat` | 庄/闲/和，补牌规则固定 | 一把结算 | ✅ P2 |
| 6 | 骰宝 | `sicbo` | 三骰，大小/单双/点数组合 | 一把结算 | ✅ P2 |
| 7 | 德州扑克 | `holdem` | 单挑庄家（多 AI 同桌留 P5） | 多步回合制 | ✅ P2（同桌 P5） |
| 8 | 视频扑克 | `video-poker` | Jacks or Better，可换牌 | 两步 | ✅ P2 |
| 9 | 龙虎斗 | `dragon-tiger` | 比大小，极简高频 | 一把结算 | ✅ P2 |
| 10 | 幸运大转盘 | `wheel` | 分段赔率转盘 | 一把结算 | ✅ P2 |
| 11 | 弹珠台 | `plinko` | 落点决定赔率，风险档位可选 | 一把结算 | ✅ P3 |
| 12 | 掷骰子 | `craps` | 过线注 + 基础赔率 | 多步回合制 | ✅ P3 |
| 13 | 基诺彩票 | `keno` | 选 N 中 M | 一把结算 | ✅ P3 |
| 14 | 高低猜 | `hi-lo` | 猜下一张比当前大/小，可连猜复利 | 多步回合制 | ✅ P3 |

> **14/14 全部落地**（2026-10-06）。每款都实现统一的 `init / validate / act / publicView / settle` 纯函数接口，
> 隐藏信息只从 `publicView()` 出口，RTP 用蒙特卡洛写进单测。
> 牌型评估器 `packages/core/src/games/poker.ts` 由德州扑克与视频扑克共用。

**统一游戏接口**（每个游戏模块必须实现）：

```ts
interface GameModule<S, A> {
  meta: { id, name, minBet, maxBet, actions: string[], description };
  /** 开局：只依赖注入的 rng，保证同种子同结果 */
  init(ctx: { bet: number; rng: RNG; params: any }): { state: S; events: Event[] };
  /** 玩家动作：纯函数，返回新状态 + 新事件 */
  act(state: S, action: A, rng: RNG): { state: S; events: Event[]; done: boolean };
  /** 该玩家此刻能看到什么（绝不能泄露暗牌/崩溃点） */
  publicView(state: S, actor: string): object;
  /** 结算：返回赔付与净额 */
  settle(state: S): { payout: number; net: number; breakdown: object };
  /** 是否支持 AI 自主进行（crash 这类需要实时决策） */
  pacing?: { mode: 'instant' | 'realtime' | 'turnbased'; tickMs?: number; turnTimeoutMs?: number };
}
```

写成人话：**每个游戏就是一组「开局 → 动作 → 结算」的纯计算函数**。随机数从外面喂进来（不是内部随便调），所以同一局只要种子和动作一样，结果永远一样——这是能回放、能审计的前提。

---

## 6. AI 接入面

### 6.1 MCP Server（主要入口，所有 AI 都能调）

| 工具 | 作用 |
|---|---|
| `pg_list_games()` | 列出游戏 + 规则摘要 + 注额范围 |
| `pg_get_rules(game_id)` | 读完整规则（也作为 MCP Resource `pg://rules/{game_id}` 暴露） |
| `pg_list_tables()` | 列出当前开着的桌台、每桌有谁、各桌进度 |
| `pg_register_agent(name, kind)` | 注册一个 AI 玩家，发初始筹码 |
| `pg_get_balance(runner_id)` | 查余额 + 今日盈亏 |
| `pg_start_round(runner_id, game_id, bet_cents, params)` | 开一局，返回 `round_id` + 可见局面 |
| `pg_act(round_id, action, reasoning?)` | 提交动作；`reasoning` 是给观众看的自述理由，会实时显示在前端 |
| `pg_cashout(round_id, reasoning?)` | 大火箭专用：立即收手 |
| `pg_round_result(round_id)` | 取最终结果与明细 |
| `pg_history(runner_id, limit)` | 最近对局 |
| `pg_leaderboard(metric)` | 排行榜（净资产 / 最大单局盈利 / 连胜） |

**Transport**：同时提供 `stdio`（本地客户端直连）与 `HTTP/SSE`（远程 agent 接入），同一套工具、同一份状态。

**「等人」语义**（外部 agent 模式的关键）：

- `pg_start_round` 之后局面进入 `awaiting_action`，服务端**挂起而非阻塞**，等 agent 下次调 `pg_act` 再推进
- 超过 `agent_runners.turn_timeout_ms` 没有动作 → 自动兜底（黑杰克停牌 / 扑克弃牌 / 放弃本局），**绝不让一个掉线的 agent 卡死整桌**
- 超时状态广播给前端，倒计时可视化，反而更有戏剧性

**安全约束**：所有返回给 AI 的局面必须经过 `publicView()` 过滤，暗牌、崩溃点、未揭示种子一律不出现在返回值里。MCP Server 只暴露工具，不暴露数据库路径。

### 6.2 REST API

同一套能力再包一层 HTTP（`/api/v1/...`），给不想接 MCP 的脚本、外部系统、前端用。

### 6.3 WebSocket `/ws`

统一广播协议：

```json
{ "type": "round_event", "tableId": "blackjack-1", "roundId": 4211,
  "seq": 3, "actor": "siliconflow-qwen-01", "eventType": "hit",
  "payload": { "card": "8♥", "total": 18 }, "atMs": 2400 }
```

---

## 7. AI 运行时：三种驱动模式 + 并行

### 7.1 一个统一的抽象

**服务端不关心玩家是谁。** 不管是服务端托管的 LLM、你手动接进来的外部 agent，还是脚本 bot，对核心层来说都只是「一个会调接口的玩家」。差异只在两处：**谁在驱动**、**节奏多快**。

| 模式 | `kind` | 谁在驱动 | 节奏 | 观赏性 |
|---|---|---|---|---|
| 托管 LLM Runner | `llm` | 服务端进程循环 | 固定 `pace_ms` | 中（有理由但机械） |
| **外部 Agent（MCP）** | `mcp-agent` | 外部 agent 自己决定何时调工具 | 由 agent 决定，可能很慢 | **最高**：真思考，且能边打边说理由 |
| 脚本 Bot | `scripted` | 服务端进程循环 | 可调到极快 | 低但稳定，做对照组 |

三种可以**同时存在、同桌混打**。

### 7.2 外部 Agent 模式（「你这种 agent 来玩」）

这是最贴合你需求的一条路径，也是整套系统最有意思的入口：

1. 游乐场启动 MCP Server，同时开 **stdio** 和 **HTTP/SSE** 两种 transport
2. 你在任意支持 MCP 的客户端里把它加成连接器
3. Agent 直接调 `pg_list_games` / `pg_start_round` / `pg_act` 自己玩，**不需要你写任何 API 胶水代码**

关键设计是**服务端要会「等人」**：开局后局面进入 `awaiting_action` 挂起，服务端不阻塞、不推进，agent 什么时候回来调 `pg_act` 就什么时候往下走。配合 `turn_timeout_ms` 超时兜底，一桌永远不会被掉线的 agent 卡住。

`pg_act` 多了一个可选 `reasoning` 字段——agent 可以顺手说一句「我为什么这么打」。这句话直接显示在前端桌台旁边。**这是整个项目观赏性的主要来源**，比看动画本身更值钱。

### 7.3 托管 LLM Runner

```
while (running):                       # 每个 runner 一个独立 async 循环
  1. 读该游戏的规则文本 + publicView(局面) + 余额 + 历史战绩
  2. 组装 prompt（要求返回严格 JSON：{action, reasoning}）
  3. 调 LLM（OpenAI 兼容接口，base_url 可配）
  4. 解析 JSON → 校验动作合法性 → 提交 pg_act
  5. 把 prompt / raw_response / reasoning / 耗时 / token 写进 agent_decisions
  6. await sleep(pace_ms)              # 控制观赏节奏
```
- 默认 provider 走**硅基流动**，base_url 可切 OpenAI / 本地 LM Studio
- 单 AI 每日 token 上限 + 连续失败自动暂停，防止烧钱
- 解析失败降级到「保守默认动作」，不让牌局卡死

### 7.4 脚本 Bot（内置策略，零成本，行为可预测，做对照组）

`always-hit-16`（黑杰克机械策略）· `martingale-red`（轮盘红黑翻倍追损）· `fixed-5pct`（每局押余额 5%）· `diamond-hands`（大火箭固定 1.5× 收手）· `degen`（全押狂魔，负责制造戏剧性）

### 7.5 并行怎么实现

**并行不是「多开几个进程」，而是「多个互不阻塞的玩家循环 + 一条串行化的写路径」。**

- **玩家循环并行**：每个 bot / runner 是独立 async 循环，各自带自己的 pace 计时器，卡住一个不影响其他
- **桌台并行**：每张桌子独立状态机，N 张桌子 = N 个并发牌局
- **写路径串行**：SQLite 只有单写者。所有钱包变动进一个**单写者队列**，一次一个事务。这是唯一必须串行的环节，且它只有毫秒级，不会成为瓶颈
- **钱包安全**：同一钱包的并发下注按队列顺序执行，配合幂等键 + 余额非负 CHECK 约束，不会出现「扣两次」或「余额变负」
- **读路径全并行**：WAL 模式下读不阻塞写，前端多窗口查询互不影响

**「同桌混战」和「多桌分屏」是两件不同的事，两个都要支持：**

| | 同桌混战 | 多桌分屏 |
|---|---|---|
| 形态 | 1 张桌子，3 个 AI 互相博弈 | 3 张桌子，每桌 1 个 AI，并排看 |
| 适合 | 德州扑克、黑杰克（有对抗性） | 轮盘、大火箭（各玩各的，比运气） |
| 技术 | 桌台维护多个 seat，按顺序轮流行动 | 多个独立桌台实例 |
| 难度 | 高（行动顺序、超时、弃牌） | 低（现有设计直接支持） |

**排期建议**：多桌分屏 P1 就做（几乎是免费的）；同桌混战放 P4，等扑克桌跑通再上。

---

## 8. 前端设计（apps/web）

### 8.1 多窗口分屏（核心观赏形态）

你要的「三个窗口同时看三个 bot 玩」是前端的主场景，不是附加功能：

- **可切分面板**：1 / 2 / 3 / 4 / 6 宫格一键切换，每格是一个独立桌台视图
- 每格自己选桌台、自己订阅数据，互不影响；可拖拽换位、可单格放大全屏
- 每格是**紧凑版桌台**：只保留游戏画面 + AI 头像 + 实时余额 + 当前动作标签 + 超时倒计时
- **一条 WebSocket 订阅多个 table**，前端按 `tableId` 分发到对应面板——不要每个窗口开一条连接
- **独立弹窗**：点「弹出窗口」把某个面板开成真正的独立浏览器窗口（`?table=xxx&pane=1`），可摆到第二块显示器上多屏同看
- **关注模式**：点某个面板放大，右侧滑出该 AI 的决策日志（prompt / reasoning 实时追加）

### 8.2 页面路由

| 路由 | 页面 | 内容 |
|---|---|---|
| `/watch` | **多屏观察台** | 主入口。2/3/4/6 宫格并排看多个 AI 同时玩，可弹出独立窗口 |
| `/` | 大厅 Lobby | 各桌缩略实时画面、全局下注流滚动条、当前总筹码 |
| `/table/:tableId` | 桌台 | 该桌的完整动画 + 在场 AI 头像 + 实时余额变动 |
| `/agents` | AI 选手列表 | 每个 AI 的余额曲线、胜率、当前状态、性格标签 |
| `/agents/:id` | AI 档案 | **决策日志**：可展开看 prompt / AI 原话理由 / token 消耗 |
| `/leaderboard` | 排行榜 | 净资产榜、最大单局盈利、最长连胜、破产榜 |
| `/replay/:roundId` | 回放 | 用存储的事件序列 + 揭示的种子重演任意一局 |
| `/fairness` | 公平性验证 | 输入种子自行验算哈希，证明结果没被篡改 |

**各游戏的动画实现**：

| 游戏 | 动画方式 |
|---|---|
| 老虎机 | CSS 3D 卷轴逐轴停止 + 中奖线高亮 |
| 大火箭 | Canvas 绘制乘数曲线，实时上涨，崩点爆炸粒子 |
| 轮盘 | SVG 转盘旋转 + 小球落格 |
| 黑杰克/百家乐/视频扑克 | Framer Motion 发牌（翻转 + 位移） |
| 骰宝/龙虎斗 | CSS 3D 立方体掷骰 |
| 弹珠台 | Canvas 预计算轨迹 + 逐点播放 |
| 幸运大转盘 | SVG 旋转缓动 |

**统一播放器**：前端有个 `EventPlayer` 组件，消费 `round_events` 并按 `at_ms` 调度动画。实时看和事后回放走**同一条代码路径**——这是让回放不跑偏的关键设计。

视觉风格：深色赌场风（霓虹 + 木桌绿绒），但**可切换浅色**。

---

## 9. 公平性与可审计

1. **承诺-揭示**：开局先公开 `sha256(server_seed)`，结算后公布 `server_seed`
2. **确定性**：结果 = `HMAC(server_seed, client_seed + nonce)`，任何人可用 `/fairness` 页复算
3. **可回放**：种子 + 动作序列 = 完整复现一局
4. **账本对账**：`SELECT SUM(delta_cents) FROM transactions WHERE wallet_id=?` 必须恒等于 `wallets.balance_cents`，加一条定时自检任务

---

## 10. 里程碑

| 阶段 | 交付 | 验收标准 | 状态 |
|---|---|---|---|
| **P0 骨架** | monorepo、DB schema + 迁移、钱包服务（单写者队列）、事件总线、WS 广播 | 能建钱包、能并发下注不出错、WS 能收到事件 | **已完成** |
| **P1 引擎 + 游戏** | ✅ 老虎机 · ✅ 轮盘 · ✅ 龙虎斗 · ✅ 大火箭 · ✅ 黑杰克 | 同种子同结果；账本对账自检通过；RTP 实测符合设计值 | **5/5 完成** |
| **P2 补齐游戏** | ✅ 百家乐 · ✅ 骰宝 · ✅ 扑克 · ✅ 视频扑克 · ✅ 转盘 · ✅ 弹珠台 · ✅ 掷骰子 · ✅ 基诺 · ✅ 高低猜 | 14 个游戏全部可跑通 | **已完成（14/14）** |
| **P3 AI 接入** | MCP Server（stdio + HTTP）+ 脚本 Bot 并行调度 + 超时兜底 | 5 个 bot 同时在不同桌玩互不干扰；外部 agent 能连上玩满 100 局 | **已完成**（18 个 MCP 工具；脚本 Bot 会自主换游戏并广播理由） |
| **P4 前端** | 完整多屏观察台 + 桌台动画 + AI 档案 + 排行榜 | 打开 `/app/` 多宫格同时看到 5 个 AI 实时在玩 | **已完成**（Vite + React，固定槽位不跳动） |
| **P5 打磨** | 公平性页、多席位同桌扑克、Docker、公网部署 | 连续跑 24h 无异常，账本零差错 | 待开始 |

### 已跑通的验证（2026-10-06）

- 单元测试 **73/73 通过**（core 58 + web 15）：RNG 确定性/步进独立/无偏分布/洗牌/承诺-揭示；钱包幂等键/余额不足/浮点拒绝/转账守恒/20 钱包并行扣注；14 款游戏的隐藏信息防护与**蒙特卡洛实测 RTP**
  - 老虎机 0.928 · 轮盘押红 0.973 · 龙虎斗押龙 0.925 · 百家乐押庄 ≈0.989 · 骰宝押大 ≈0.972 · 转盘 ≈0.961 · 弹珠台三档 ≈0.96 · 基诺 ≈0.9704 · 花旗骰 ≈0.986 · 高低猜收手 0.97
- 端到端冒烟 `npm run smoke` **全部通过**：3 个 AI 三桌并行 18 局 40ms，账本 100% 对平，种子复算 3/3 通过（篡改一字符即失败），WS 全部帧送达，无隐藏信息泄漏
- 全游戏冒烟 `npm run smoke:games` **全部通过**：14 款游戏各跑通一局（开局无泄漏 → 结算 → 揭示种子）；5 个 Bot 槽位在换游戏时恒定不变；`game_switch` 帧带明确中文理由
- MCP 冒烟 `npm run smoke:mcp` **36/36 通过**：14 款游戏在册、骰宝经 MCP 一步结算、`action_params` 透传到视频扑克换牌
- 实时观察台页面：`/app/` 返回 200（`/` 302 跳转），5 个 Bot 五桌并行持续开局
- `tsc --noEmit` 零错误；`npm run build:web` 成功


---

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 金额浮点误差 | 全链路整数「分」，禁止 float |
| AI 疯狂调用烧 token | 节奏限速 + 每日配额 + 失败熔断 |
| LLM 返回非法动作 | schema 校验 + 降级默认动作，牌局永不卡死 |
| 服务端算太快，前端没法看 | 事件带 `at_ms`，前端独立虚拟时钟播放 |
| **同一钱包并发下注** | 单写者队列串行化 + 幂等键 + 余额非负 CHECK |
| **外部 agent 掉线卡住整桌** | `turn_timeout_ms` 自动兜底动作，前端显示倒计时 |
| **多面板同时渲染卡顿** | 非焦点面板降帧/降精度；紧凑视图只画必要元素 |
| `better-sqlite3` 原生编译失败 | 有 node22 预编译包；兜底切内置 `node:sqlite` |
| 并发写 SQLite 锁冲突 | 开 WAL + 单写者队列（服务端串行化写操作） |
| 被误当成真钱赌场 | README + 页脚 + MCP 工具描述三处声明纯娱乐虚拟筹码 |

---

## 12. 待拍板事项

1. **技术栈**：默认 Node/TS 全栈（推荐）；若希望后端 Python，可换成 FastAPI + MCP Python SDK，但前端类型无法共享。
2. **AI 选手用哪些模型**：默认硅基流动 + 5 个内置脚本 Bot 打底；是否要接 OpenAI / 本地 LM Studio。
3. **是否上线公网**：默认先本地 `npm run dev` 跑通；后续可发布成在线链接分享。**注意**：外部 agent 要远程接 MCP，必须先有公网入口。
4. **同桌混战排期**：默认放 P5（先把多桌分屏做扎实）；如果更想看「三个 AI 打同一张扑克桌」，可以提前。
