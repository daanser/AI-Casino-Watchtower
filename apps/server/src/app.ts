/**
 * HTTP API + WebSocket 服务
 *
 * 这一层只做三件事：解析请求、调用 core、把结果（或错误）返回。
 * 所有游戏逻辑和金额计算都在 packages/core 里，这里一行都不许有。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, type WebSocket } from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, openDb, type Db } from '@ai-gaming/db';
import { EventBus, RoundService, WalletService } from '@ai-gaming/core';
import { PlaygroundRunner } from '@ai-gaming/agents';
import { PlaygroundError, type ServerFrame } from '@ai-gaming/shared';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(HERE, '..', 'public');

export interface AppBundle {
  app: FastifyInstance;
  db: Db;
  bus: EventBus;
  wallets: WalletService;
  rounds: RoundService;
  runner: PlaygroundRunner;
  close: () => Promise<void>;
}

export interface AppOptions {
  dbPath?: string;
  migrateOnBoot?: boolean;
  /** 启动时就放脚本 Bot 上场，打开页面立刻有戏看 */
  demo?: boolean;
  /** 节奏缩放，1 = 正常 */
  speed?: number;
}

export function createApp(opts: AppOptions = {}): AppBundle {
  const db = openDb(opts.dbPath);
  if (opts.migrateOnBoot !== false) migrate(db);

  const bus = new EventBus();
  const wallets = new WalletService(db);
  const rounds = new RoundService(db, wallets, bus);

  const runner = new PlaygroundRunner(rounds, wallets, {
    speed: opts.speed,
    onLog: (msg: string) => console.log(`  ${msg}`),
  });

  const app = Fastify({ logger: false });

  /** 所有连上来的观察端。一条广播，所有窗口共享。 */
  const wsClients = new Set<WebSocket>();

  // ── 开发期放开 CORS，前端才能直连 ────────────────────────────
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') reply.code(204).send();
  });

  // ── 统一错误出口：PlaygroundError 带着自己的状态码 ────────────
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof PlaygroundError) {
      reply.code(err.status).send({ error: err.code, message: err.message });
      return;
    }
    const e = err as Error & { statusCode?: number };
    reply.code(e.statusCode ?? 500).send({ error: 'INTERNAL', message: e.message });
  });

  // ═════════════════════════════════════════════════════════════
  // 观察台前端
  // ═════════════════════════════════════════════════════════════
  //
  // 正经前端（Vite + React）构建产物落在 public/app/ 下。
  // 万一还没构建（比如刚 clone 下来、还没跑 npm run build:web），
  // 就退回到 public/index.html 那个单文件版本，保证「打开就有东西看」。

  const APP_DIR = resolve(WEB_DIR, 'app');
  const HAS_BUILD = existsSync(resolve(APP_DIR, 'index.html'));

  if (HAS_BUILD) {
    app.register(fastifyStatic, {
      root: APP_DIR,
      prefix: '/app/',
      decorateReply: false,
    });
    app.get('/', async (_req, reply) => reply.redirect('/app/'));
  } else {
    app.get('/', async (_req, reply) => {
      reply.type('text/html; charset=utf-8');
      // 每次请求都重新读盘，改完刷新就生效，不用重启
      return readFileSync(resolve(WEB_DIR, 'index.html'), 'utf8');
    });
  }

  // ═════════════════════════════════════════════════════════════
  // 健康检查与总览
  // ═════════════════════════════════════════════════════════════

  app.get('/api/v1/health', async () => ({
    ok: true,
    service: 'ai-gaming',
    wsClients: wsClients.size,
    games: rounds.registry.size,
    bots: runner.status().length,
    frontend: HAS_BUILD ? 'vite' : 'legacy',
  }));

  app.get('/api/v1/bots', async () => runner.status());

  app.get('/api/v1/state', async () => ({
    wallets: wallets.list(),
    tables: rounds.tables(),
    games: rounds.registry.list().map((g) => g.meta),
    bots: runner.status(),
    recentRounds: rounds.recentRounds(20),
    reconcile: wallets.reconcileAll(),
  }));

  // ═════════════════════════════════════════════════════════════
  // 游戏
  // ═════════════════════════════════════════════════════════════

  app.get('/api/v1/games', async () =>
    rounds.registry.list().map((g) => {
      const cfg = rounds.config(g.meta.id);
      return {
        ...g.meta,
        minBetCents: cfg.min_bet_cents,
        maxBetCents: cfg.max_bet_cents,
        enabled: cfg.enabled === 1,
      };
    }),
  );

  app.get('/api/v1/games/:id/rules', async (req) => {
    const { id } = req.params as { id: string };
    const game = rounds.registry.require(id);
    return { id, name: game.meta.name, description: game.meta.description, actions: game.meta.actions };
  });

  // ═════════════════════════════════════════════════════════════
  // 钱包
  // ═════════════════════════════════════════════════════════════

  app.get('/api/v1/wallets', async () => wallets.list());

  app.post('/api/v1/wallets', async (req, reply) => {
    const body = (req.body ?? {}) as {
      ownerType?: string;
      ownerId?: string;
      displayName?: string;
      initialCents?: number;
    };
    if (!body.ownerId || !body.displayName) {
      throw new PlaygroundError('INTERNAL', 'ownerId 和 displayName 必填', 400);
    }
    const wallet = wallets.create({
      ownerType: (body.ownerType as 'agent' | 'human' | 'house' | 'system') ?? 'agent',
      ownerId: body.ownerId,
      displayName: body.displayName,
      initialCents: body.initialCents ?? 0,
    });
    reply.code(201);
    return wallet;
  });

  app.get('/api/v1/wallets/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    return {
      wallet: wallets.getOrThrow(id),
      transactions: wallets.transactions(id, 50),
      reconcile: wallets.reconcile(id),
    };
  });

  app.get('/api/v1/wallets/:id/transactions', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const limit = Number((req.query as { limit?: string }).limit ?? 50);
    return wallets.transactions(id, Math.min(limit, 500));
  });

  /** 发筹码 / 破产救济 */
  app.post('/api/v1/wallets/:id/grant', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { cents?: number; reason?: string };
    const cents = Number(body.cents ?? 0);
    if (!Number.isInteger(cents) || cents <= 0) {
      throw new PlaygroundError('INTERNAL', 'cents 必须是正整数（单位：分）', 400);
    }
    const key = `grant:${id}:${Date.now()}`;
    const result = wallets.apply({
      walletId: id,
      kind: body.reason === 'relief' ? 'relief' : 'grant',
      deltaCents: cents,
      idemKey: key,
    });
    return { wallet: wallets.getOrThrow(id), tx: result };
  });

  // ═════════════════════════════════════════════════════════════
  // 对局
  // ═════════════════════════════════════════════════════════════

  app.get('/api/v1/rounds', async (req) => {
    const q = req.query as { limit?: string; walletId?: string };
    return rounds.recentRounds(
      Math.min(Number(q.limit ?? 30), 200),
      q.walletId ? Number(q.walletId) : undefined,
    );
  });

  /** 开一局：建局 + 扣注，同一事务 */
  app.post('/api/v1/rounds', async (req, reply) => {
    const body = (req.body ?? {}) as {
      walletId?: number;
      gameId?: string;
      betCents?: number;
      params?: Record<string, unknown>;
      clientSeed?: string;
      tableId?: string;
      actor?: string;
      reasoning?: string;
    };
    if (body.walletId === undefined || !body.gameId || body.betCents === undefined) {
      throw new PlaygroundError('INTERNAL', 'walletId / gameId / betCents 必填', 400);
    }
    const round = await rounds.start({
      walletId: Number(body.walletId),
      gameId: body.gameId,
      betCents: Number(body.betCents),
      params: body.params,
      clientSeed: body.clientSeed,
      tableId: body.tableId,
      actor: body.actor,
      reasoning: body.reasoning,
    });
    reply.code(201);
    return round;
  });

  app.get('/api/v1/rounds/:id', async (req) =>
    rounds.getRound(Number((req.params as { id: string }).id)),
  );

  app.get('/api/v1/rounds/:id/events', async (req) =>
    rounds.events(Number((req.params as { id: string }).id)),
  );

  /** 公平性验证：复算公布的种子是否对应开局时那个哈希 */
  app.get('/api/v1/rounds/:id/verify', async (req) =>
    rounds.verifyRound(Number((req.params as { id: string }).id)),
  );

  /**
   * 提交动作。
   * reasoning 就是「我为什么这么打」——会存成事件并实时推给前端。
   */
  app.post('/api/v1/rounds/:id/action', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as {
      action?: { type?: string; [k: string]: unknown };
      reasoning?: string;
      actor?: string;
    };
    if (!body.action?.type) {
      throw new PlaygroundError('INVALID_ACTION', 'action.type 必填', 400);
    }
    return rounds.act(id, body.action as { type: string }, {
      reasoning: body.reasoning,
      actor: body.actor,
    });
  });

  // ═════════════════════════════════════════════════════════════
  // 桌台与对账
  // ═════════════════════════════════════════════════════════════

  app.get('/api/v1/tables', async () => rounds.tables());

  /**
   * 换桌公告：让**外部 agent** 也能发「自主换桌」提示。
   *
   * `rounds.announceGameSwitch()` 一直都在，但此前只有脚本 Bot 的 runner 会调它 ——
   * 外部 MCP / HTTP agent 换游戏时前端**不会**弹那条醒目的「自主换桌」卡片，
   * 顶部的「刚刚换桌」横幅也不会出现，换桌理由等于没地方说。
   * 而观察台的观赏性有一半来自「AI 为什么换」—— 这个端点把缺口补上。
   *
   * 调用时机：**换游戏之前**。fromGameId 不传时按该桌最近一次活动推出来，
   * 所以先公告再开局，推出来的才是真正的「从哪张桌换过来」。
   */
  app.post('/api/v1/game-switch', async (req) => {
    const body = (req.body ?? {}) as {
      tableId?: string;
      displayName?: string;
      fromGameId?: string;
      toGameId?: string;
      reason?: string;
    };
    if (!body.tableId || !body.toGameId || !body.reason) {
      throw new PlaygroundError('INTERNAL', 'tableId / toGameId / reason 必填', 400);
    }

    const fromGameId =
      body.fromGameId ??
      rounds
        .tables()
        .filter((t) => t.tableId === body.tableId)
        .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))[0]
        ?.gameId ??
      '';

    rounds.announceGameSwitch({
      botId: body.tableId,
      displayName: body.displayName ?? body.tableId,
      tableId: body.tableId,
      fromGameId,
      toGameId: body.toGameId,
      reason: body.reason,
    });

    return { ok: true, tableId: body.tableId, fromGameId, toGameId: body.toGameId };
  });

  /**
   * 账本自检：流水累加必须恒等于钱包余额。
   * 只要有一个钱包对不上，就说明有人绕过了 WalletService.apply()。
   */
  app.get('/api/v1/reconcile', async () => {
    const results = wallets.reconcileAll();
    return { ok: results.every((r) => r.ok), checked: results.length, results };
  });

  // ═════════════════════════════════════════════════════════════
  // WebSocket：前端多屏观察台的数据来源
  // ═════════════════════════════════════════════════════════════

  const wss = new WebSocketServer({ server: app.server, path: '/ws' });

  wss.on('connection', (socket) => {
    wsClients.add(socket);
    socket.send(
      JSON.stringify({
        type: 'hello',
        serverTime: new Date().toISOString(),
      }),
    );
    socket.on('close', () => wsClients.delete(socket));
    socket.on('error', () => wsClients.delete(socket));
  });

  // 一条广播，所有窗口共享。前端按 tableId 分发到各个面板。
  const unsubscribe = bus.subscribe((frame: ServerFrame) => {
    const text = JSON.stringify(frame);
    for (const client of wsClients) {
      if (client.readyState === 1) {
        try {
          client.send(text);
        } catch {
          wsClients.delete(client);
        }
      }
    }
  });

  // 放在最后启动：必须等 WS 广播订阅挂好，否则开局头几帧会丢
  if (opts.demo) runner.start();

  return {
    app,
    db,
    bus,
    wallets,
    rounds,
    runner,
    close: async () => {
      runner.stop();
      unsubscribe();
      for (const c of wsClients) c.close();
      wss.close();
      await app.close();
      db.close();
    },
  };
}
