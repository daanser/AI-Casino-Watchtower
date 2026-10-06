#!/usr/bin/env node
/**
 * AI 游乐场 MCP Server 入口。
 *
 * 两种传输：
 *   stdio（默认）—— 给 Claude Desktop / CodeBuddy 这类本地客户端用，配到 mcp.json 里即可
 *   HTTP（--http）—— 给远程 agent 用，StreamableHTTP，POST 到 /mcp
 *
 * ⚠️ stdio 模式下 stdout 是 JSON-RPC 通道，任何 console.log 都会污染协议。
 *    所以这里的日志一律走 console.error（stderr）。
 */

import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PlaygroundApi } from './api';
import { buildServer } from './server';

const API_URL = process.env.PG_API_URL ?? 'http://127.0.0.1:5173';
const USE_HTTP = process.argv.includes('--http') || process.env.PG_MCP_HTTP === '1';
const HTTP_PORT = Number(process.env.PG_MCP_PORT ?? 5199);
const HTTP_PATH = process.env.PG_MCP_PATH ?? '/mcp';

const api = new PlaygroundApi({ baseUrl: API_URL });

/** 启动前先探一下主服务在不在，省得 agent 一头雾水 */
async function assertBackend(): Promise<void> {
  try {
    const h = await api.health();
    console.error(`  ✅ 已连上游乐场主服务 ${API_URL}（${h.games} 个游戏，${h.bots} 个 Bot）`);
  } catch (err) {
    console.error(`  ⚠️  连不上游乐场主服务 ${API_URL}`);
    console.error(`      ${(err as Error).message}`);
    console.error('      工具仍会注册，但调用时会失败。请先启动主服务：npm start');
  }
}

async function runStdio(): Promise<void> {
  const server = buildServer(api);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`  🔷 MCP Server 已就绪（stdio）→ ${API_URL}`);
}

async function runHttp(): Promise<void> {
  // stateless：每个请求新建一套 transport + server，互不干扰
  const httpServer = createHttpServer(async (req, res) => {
    if (!req.url?.startsWith(HTTP_PATH)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'NOT_FOUND', message: `请 POST 到 ${HTTP_PATH}` }));
      return;
    }

    // 读取请求体
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'BAD_JSON', message: '请求体不是合法 JSON' }));
      return;
    }

    const server = buildServer(api);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error('  MCP 请求处理失败:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }),
        );
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(HTTP_PORT, '127.0.0.1', resolve));
  console.error(`  🔷 MCP Server 已就绪（HTTP）`);
  console.error(`     ${HTTP_PATH}  http://127.0.0.1:${HTTP_PORT}${HTTP_PATH}`);
  console.error(`     上游         ${API_URL}`);
  console.error(`     会话 id      ${randomUUID().slice(0, 8)}…（stateless，每次请求独立）`);
}

async function main(): Promise<void> {
  await assertBackend();
  if (USE_HTTP) await runHttp();
  else await runStdio();
}

main().catch((err) => {
  console.error('MCP Server 启动失败:', err);
  process.exit(1);
});
