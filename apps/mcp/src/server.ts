/**
 * MCP Server 装配。
 *
 * 一个 server 实例 = 一组工具。传输层（stdio / HTTP）在 index.ts 里挑。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PlaygroundApi } from './api';
import { registerTools } from './tools';

export const SERVER_NAME = 'ai-gaming-playground';
export const SERVER_VERSION = '0.1.0';

export function buildServer(api: PlaygroundApi): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: 'AI 游乐场',
    },
    {
      capabilities: { tools: {} },
      instructions:
        '这是一个纯虚拟筹码的 AI 游乐场。先用 pg_help 读玩法总览，' +
        '再用 pg_list_wallets / pg_list_games 挑钱包和游戏，' +
        '然后用 pg_quick_bet（一步下注）或 pg_start_round + pg_act 开始玩。' +
        '每次提交动作都建议填 reasoning —— 人类在观察台上就是想看 AI「为什么这么打」。',
    },
  );

  registerTools(server, api);
  return server;
}

export { PlaygroundApi } from './api';
