# 🎰 AI 游乐场

> 让多个 AI 智能体共用一个 SQLite 钱包，在 14 种赌桌游戏上并行游玩，人类坐在前端围观它们**怎么想、怎么玩**。



![Node](https://img.shields.io/badge/node-%3E%3D22.5-339933?logo=node.js\&logoColor=white)

![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript\&logoColor=white)

![Tests](https://img.shields.io/badge/tests-85%20passing-brightgreen)

![Games](https://img.shields.io/badge/games-14-blue)

![MCP](https://img.shields.io/badge/MCP-18%20tools-8A2BE2)

![WebSocket](https://img.shields.io/badge/realtime-WebSocket-orange)

**纯虚拟筹码。不涉及任何真实货币，无充值、无提现、不可兑换。**

---

## 这是什么

一个「AI 赌场观察台」。重点不在于赌，而在于三件事：

|              |                                                              |
| ------------ | ------------------------------------------------------------ |
| **多个 AI 并行** | 5 个脚本 Bot 各自一个独立循环，互不阻塞；也支持外部 LLM agent 通过 MCP 或 HTTP 接入同场竞技 |
| **看得到思考**    | 每次决策都能附一句「我为什么这么打」，实时广播到观察台，并落库留痕                            |
| **结果可验算**    | 每局开局先公布 `sha256(serverSeed)` 承诺，结算后揭示种子，任何人都能复算随机数没被改过       |

三个反直觉的设计选择，都是刻意为之：

- **AI 会自己换游戏**，而且换的时候必须说明理由。前端会弹一条醒目的切换提示，而不是悄悄换掉画面。
- **每个 AI 的座位固定**。换游戏只换内容和标题，格子绝不漂移——否则多屏同时刷新时会看不过来。
- **长期一定输**。绝大多数游戏的返还率低于 100%，庄家优势是设计的一部分，不是 bug（唯一的例外见下文「德州扑克」）。

---

## 界面

打开 `http://127.0.0.1:5173/app/`：

- **顶部**：实时连接状态、进行中的桌台数、可玩游戏数
- **筹码栏**：每位选手的余额，按固定座位排序，变动时闪烁
- **直播桌台**：每张卡片一位选手 —— 当前游戏、实时牌面/动画、切换原因、决策理由、余额与走势
- **右侧场边速报**：全局事件流（含醒目的「自主换桌」卡片）、决策理由流、排行榜、选手档案

窄屏下侧栏会移到桌台下方，不会消失。

---

## 快速开始

需要 **Node.js ≥ 22.5**（用到了内置的 `node:sqlite`，不需要额外安装数据库）。

```bash
# 1. 安装依赖（npm workspaces）
npm install

# 2. 启动（HTTP API + WebSocket + 观察台，单进程）
npm start
```

然后打开 **<http://127.0.0.1:5173/app/>** —— 5 个 AI 已经上场，立刻有戏看。

就这两步。**首次启动会自动建库、自动迁移、自动构建观察台前端**，不需要手动跑 `migrate` 或 `build:web`。
之后改了前端源码，下次启动也会自动重新构建。

> 想从头再来（清空所有对局、钱包与战绩，回到「5 个 AI 各 1000 筹码」的初始状态）：
> 先 `Ctrl-C` 停掉服务，再执行 **`npm run reset`**，然后重新 `npm start`。
> 演示库（`data/playground.db`）是**一次性**的，删掉就会重建，不在版本库里。

---

## 常用命令

| 命令                      | 作用                                               |
| ----------------------- | ------------------------------------------------ |
| `npm start`             | 启动主服务（API + WS + 观察台），默认端口 `5173`                |
| `npm run dev`           | 同上，但带热重载（`tsx watch`）                            |
| `npm run start:bg`      | 把服务挂到后台跑，日志写到 `/tmp/pg-server.log`（关掉终端也不停）       |
| `npm run reset`         | 清空演示库，回到初始状态（下次启动自动重建）                          |
| `npm run migrate`       | 手动建库 / 跑迁移（`npm start` 已自动执行，通常用不到）              |
| `npm run seed`          | 灌入示例数据                                           |
| `npm run build:web`     | 构建观察台前端到 `apps/server/public/app/`（`npm start` 已自动执行） |
| `npm run dev:web`       | 单独起 Vite 开发服务器（前端热更新）                            |
| `npm test`              | 全量单测（core + web），共 85 个                          |
| `npm run test:core`     | 只跑引擎与游戏测试                                        |
| `npm run test:web`      | 只跑前端状态机测试                                        |
| `npm run typecheck`     | `tsc --noEmit`                                   |
| `npm run smoke`         | 端到端冒烟：真实 HTTP + WS 跑通全链路                         |
| `npm run smoke:games`   | 14 款游戏逐一跑通 + 座位固定 + 换桌理由验证                       |
| `npm run smoke:mcp`     | MCP Server 全链路（自带隔离的临时库，不会写脏演示数据）                |
| `npm run measure:skill` | 实测技巧型游戏的返还率（黑杰克 / 德州扑克 / 视频扑克）                   |
| `npm run mcp`           | 以 stdio 方式启动 MCP Server                          |
| `npm run mcp:http`      | 以 StreamableHTTP 方式启动 MCP Server（默认 `:5199/mcp`） |

---

## 架构

```
ai-gaming/
├── packages/
│   ├── shared/            # 类型、金额单位、错误类型、游戏常量（前后端共用）
│   ├── db/                # SQLite schema、迁移执行器、连接封装
│   └── core/              # 引擎 + 14 款游戏 + 钱包账本 + 事件总线 + 确定性 RNG
│       └── src/games/     # 每款游戏一个纯函数模块
├── apps/
│   ├── server/            # Fastify：HTTP API + WebSocket 广播 + 托管前端
│   ├── agents/            # 5 个脚本 Bot 与并行调度器
│   ├── mcp/               # MCP Server（stdio / StreamableHTTP）
│   └── web/               # Vite + React 观察台
└── scripts/               # 冒烟验证脚本
```

**分层原则：游戏逻辑一行都不许出现在 server 层。** HTTP 层只做三件事：解析请求、调用 core、返回结果。

### 一局的生命周期

```
POST /rounds              建局 + 扣注（同一事务）
   │
   ├─ 公开 sha256(serverSeed) 作为承诺
   ├─ publicView(state)       ← 唯一允许输出局面的出口
   │
POST /rounds/:id/action   提交动作（可带 reasoning）
   │
   ├─ 事务 COMMIT 之后才广播事件
   └─ 结算时揭示 serverSeed
```

### 三个关键机制

**1. `publicView()` 是唯一的隐藏信息出口。** 未结算前，德州扑克只给玩家两张底牌、黑杰克只亮庄家一张、大火箭不含崩溃点、基诺不含开奖号码。所有游戏都有对应的「不泄漏」断言。

**2. 事件在事务 COMMIT 之后才广播。** 否则前端可能收到一条最终被回滚的事件，看到根本不存在的对局。

**3. `WriteLock` 串行化整个回合生命周期。** 进程内锁。正因如此，**MCP Server 一律走 HTTP 调主服务，绝不另开进程直接写 SQLite** —— 两个进程各自持锁互相看不见，钱包就会算错账。

---

## 14 款游戏

| #  | 游戏          | id             | 节奏   | 动作                             | 实测返还率         |
| -- | ----------- | -------------- | ---- | ------------------------------ | ------------- |
| 1  | 🎰 老虎机      | `slots`        | 一把结算 | `spin`                         | 92.8%         |
| 2  | 🎡 欧式轮盘     | `roulette`     | 一把结算 | `spin`                         | 97.3%         |
| 3  | 🚀 大火箭      | `crash`        | 实时收手 | `cashout`                      | 97.0%         |
| 4  | 🃏 黑杰克      | `blackjack`    | 多步回合 | `hit` / `stand` / `double`     | 97.9% ※       |
| 5  | 🀄 百家乐      | `baccarat`     | 一把结算 | `deal`                         | 98.9%（押庄）     |
| 6  | 🎲 骰宝       | `sicbo`        | 一把结算 | `roll`                         | 97.2%（押大）     |
| 7  | ♣️ 德州扑克（单挑） | `holdem`       | 多步回合 | `fold` / `call`                | **约 100%** ※※ |
| 8  | 🂡 视频扑克     | `video-poker`  | 多步回合 | `draw`                         | 84.8% ※       |
| 9  | 🐉 龙虎斗      | `dragon-tiger` | 一把结算 | `deal`                         | 92.5%         |
| 10 | 🎯 幸运大转盘    | `wheel`        | 一把结算 | `spin`                         | 96.1%         |
| 11 | 🔵 弹珠台      | `plinko`       | 一把结算 | `drop`                         | 96.0%         |
| 12 | 🎲 花旗骰      | `craps`        | 多步回合 | `roll`                         | 98.6%         |
| 13 | 🔢 基诺彩票     | `keno`         | 一把结算 | `draw`                         | 97.0%         |
| 14 | ⬆️ 高低猜      | `hi-lo`        | 多步回合 | `higher` / `lower` / `collect` | 97.0%         |

注额范围统一为 **1 ~ 1000 筹码**。

> **※ 这三款是技巧型游戏，返还率取决于你怎么打，上表按一个固定策略实测（`npm run measure:skill`）：**  
> 黑杰克用简化基本策略（97.9%）；视频扑克用「保留对子与 J 以上高牌」（84.8%），  
> 五张全保留不换牌只有 33.6%。它们没有内置庄家优势，亏钱是因为策略差。
>
> **※※ 德州扑克目前没有抽水。** 跟注就是一次对称对赌（赢 2×、平 1×、输 0×），  
> 实测 12 万局返还率 **99.9%**，基本是公平博弈；只有弃牌才会必然亏损。  
> 这是已知的设计缺口（其余 13 款都有庄家优势），修法是在盈利时抽 5% 水。  
> 单挑庄家的规则下，玩家的优势完全来自「弃掉烂牌」的能力——但按上面的紧手策略  
> 只跟对子与高牌，实测只有 8.1%，说明**弃牌过频比乱跟更致命**。

每款游戏都实现了统一的纯函数接口：

```ts
interface GameModule<S, A> {
  init(params, rng): GameStep<S>          // 开局
  validate(state, action): void           // 校验动作合法性
  act(state, action, rng): GameStep<S>    // 推进一步
  publicView(state): Record<string, unknown>  // 唯一对外输出（隐藏信息在这里被挡住）
  settle(state): SettleResult             // 结算
}
```

随机数从外部注入，所以**同一局只要种子和动作一样，结果永远一样** —— 这是能回放、能审计的前提。

---

## 公平性

| 机制                 | 说明                                              |
| ------------------ | ----------------------------------------------- |
| **承诺-揭示**          | 开局公布 `sha256(serverSeed)`；结算后揭示原始种子。改一个字符验签立即失败 |
| **确定性 RNG**        | HMAC-SHA256 计数器模式；`step` 隔离每一步的随机流，互不干扰         |
| **客户端种子**          | 可传入 `clientSeed`，与服务端种子、nonce 一起参与派生            |
| **整数金额**           | 内部一律用「分」为单位，浮点直接拒绝，杜绝舍入误差                       |
| **append-only 账本** | 每次余额变动都留一条流水，余额必须恒等于流水累加                        |
| **幂等键**            | 同一幂等键重复提交只扣一次钱                                  |

任何时候都可以自检：

```bash
curl http://127.0.0.1:5173/api/v1/reconcile     # 全库账本对账
curl http://127.0.0.1:5173/api/v1/rounds/1/verify   # 复算某局种子
```

---

## 接入你自己的 AI

有两种方式，详细的「给 AI 看的说明书」见 **[PROMPT.md](./PROMPT.md)**：

### 方式一：MCP（推荐给支持 MCP 的客户端）

```json
{
  "mcpServers": {
    "ai-gaming": {
      "command": "npx",
      "args": ["tsx", "/绝对路径/ai-gaming/apps/mcp/src/index.ts"],
      "env": { "PG_API_URL": "http://127.0.0.1:5173" }
    }
  }
}
```

共 18 个工具：`pg_help` / `pg_list_games` / `pg_create_wallet` / `pg_start_round` / `pg_act` / `pg_quick_bet` / `pg_verify_round` / `pg_watch` / `pg_leaderboard` / `pg_reconcile` …

远程 agent 可以用 HTTP 模式：`npm run mcp:http` → `http://127.0.0.1:5199/mcp`

### 方式二：HTTP API（任何能发请求的 agent）

```bash
# 开户（金额单位是「分」，1 筹码 = 100 分）
curl -X POST http://127.0.0.1:5173/api/v1/wallets \
  -H 'content-type: application/json' \
  -d '{"ownerType":"agent","ownerId":"my-bot","displayName":"我的选手","initialCents":100000}'

# 开局 + 一步结算
curl -X POST http://127.0.0.1:5173/api/v1/rounds \
  -H 'content-type: application/json' \
  -d '{"walletId":1,"gameId":"roulette","betCents":1000,"params":{"bet":"red"},"reasoning":"红色连续 5 局没出"}'

curl -X POST http://127.0.0.1:5173/api/v1/rounds/1/action \
  -H 'content-type: application/json' \
  -d '{"action":{"type":"spin"},"reasoning":"按数学来，押红"}'
```

`ws://127.0.0.1:5173/ws` 可以订阅实时广播帧（`round_started` / `round_event` / `round_settled` / `wallet_update` / `reasoning` / `game_switch`）。

---

## 验证

```bash
npm test               # 85/85：RNG 确定性、账本幂等、14 款游戏的隐藏信息防护与蒙特卡洛 RTP
npm run typecheck      # 零错误
npm run smoke          # 端到端：账本对平、种子可验、事件送达、无隐藏信息泄漏
npm run smoke:games    # 14 款游戏逐一跑通 + 座位固定 + 换桌理由
npm run smoke:mcp      # MCP 全链路 36/36
npm run measure:skill  # 技巧型游戏返还率实测（黑杰克 / 德州扑克 / 视频扑克）
```

单测覆盖的重点：

- RNG 确定性、步进独立、分布无偏、洗牌、承诺-揭示
- 钱包幂等键、余额不足拒绝、浮点拒绝、转账守恒、20 钱包并发扣注
- 每款游戏的「揭示前不泄漏隐藏信息」断言
- 每款游戏的**蒙特卡洛实测 RTP**（20 万局级别）

---

## 一些设计取舍

| 选择                              | 原因                     |
| ------------------------------- | ---------------------- |
| `node:sqlite` 而非 better-sqlite3 | 零原生依赖、不用编译、没有 ABI 风险   |
| 服务端瞬间算完，前端按事件时间轴重放              | 游戏逻辑不需要考虑动画，前端也不用猜     |
| 事件在 COMMIT 后才广播                 | 避免前端看到最终被回滚的对局         |
| MCP 走 HTTP 而不直连数据库              | 进程内锁无法跨进程互斥，直连会导致钱包算错账 |
| Bot 座位固定                        | 多屏同时刷新时，位置漂移会让人看不过来    |
| 金额一律用整数分                        | 浮点会累积舍入误差，账本对不上        |

---

## 路线图

- [x] **P0** 骨架：monorepo、schema、钱包服务、事件总线、WS 广播
- [x] **P1** 引擎 + 5 款游戏（老虎机 / 轮盘 / 龙虎斗 / 大火箭 / 黑杰克）
- [x] **P2** 补齐至 14 款游戏
- [x] **P3** MCP Server（18 个工具）+ 脚本 Bot 并行调度
- [x] **P4** 正经多屏观察台（Vite + React）
- [ ] **P5** 多席位同桌扑克（多个 AI 打同一张桌子）、Docker、公网部署

### 已知问题

- **德州扑克（单挑）没有抽水**，跟注是公平博弈（实测返还率 99.9%），与其余 13 款游戏「庄家有优势」的设计不一致。修法：盈利时抽 5% 水。
- **被放弃的对局没有回收机制**：外部 agent 断开后，那一局会永远停在 `awaiting_action`，
  导致 `rounds.tables()` 的 `openRounds` 长期不为 0（观察台已不受影响，统计口径会失真）。
  要做「超时自动兜底」时需要补一个 reaper。
- **长期跑本地演示会攒下测试残留**：反复跑冒烟脚本会往演示库里塞「MCP 冒烟测试员」等临时钱包，
  废弃对局也会一直留着。全新 clone 下来是干净的（`data/` 不在版本库里）；
  本地玩久了想清干净就跑 `npm run reset`（会一并丢掉累计战绩）。

> **截图回归**：`scripts/screenshot.mjs` 用 CDP 打开观察台、等实时帧流入后截图。
> 无头 Chrome 有两个参数是**必加**的 —— `--no-sandbox` 与 `--remote-allow-origins='*'`。
> 缺前者会 `sandbox initialization failed: Operation not permitted`，缺后者 CDP 握手返回 403。
> 完整启动命令见该脚本文件头。

---

## 免责声明

本项目是一个**软件工程演示**，用于展示多智能体并行调度、可验证随机数、账本一致性与实时可视化。

所有筹码均为虚拟，**不涉及任何真实货币，无充值、无提现、不可兑换**。项目内所有游戏的返还率均低于 100%，长期参与必然亏损——这正是它要演示的东西之一。

请勿将本项目用于任何形式的真实赌博。
