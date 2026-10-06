import type { BotStatus, WalletRow } from '../lib/types';
import { coins } from '../lib/format';

export type GridCols = 1 | 2 | 3 | 4 | 6;

export function TopBar({
  connected,
  onOpenReplay,
  runningTables,
  gameCount,
}: {
  connected: boolean;
  onOpenReplay: () => void;
  runningTables: number;
  gameCount: number;
}) {
  return (
    <header className="topbar">
      <div className="brand" aria-label="AI 游乐场">
        <span className="brand-mark" aria-hidden="true"><span>◆</span></span>
        <span className="brand-wordmark">AI<span> / </span>游乐场<small>THE PLAYGROUND</small></span>
      </div>
      <div className="topbar-divider" />
      <span className="topbar-location">观察台 <span>/</span> LIVE FLOOR</span>
      <div className="topbar-spacer" />
      <div className={`connection ${connected ? 'connected' : ''}`} role="status">
        <span className="connection-dot" />
        {connected ? '直播信号正常' : '连接中断 · 正在重连'}
      </div>
      <span className="topbar-meta">{runningTables} 桌进行中 <i /> {gameCount} 种玩法</span>
      <button className="topbar-action" type="button" onClick={onOpenReplay}>
        <span aria-hidden="true">↺</span> 回放一局
      </button>
    </header>
  );
}

/** 每位内置 Bot 始终占自己的位置；外部钱包在其后面展示。 */
export function WalletBar({
  wallets,
  bots,
  pulse,
}: {
  wallets: WalletRow[];
  bots: BotStatus[];
  pulse: Record<number, { delta: number; at: number }>;
}) {
  const now = Date.now();
  const ordered = bots.length
    ? [
        ...bots.map((bot) => ({ wallet: wallets.find((w) => w.id === bot.walletId), bot })),
        ...wallets.filter((w) => !bots.some((bot) => bot.walletId === w.id)).map((wallet) => ({ wallet, bot: null })),
      ]
    : wallets.map((wallet) => ({ wallet, bot: null }));

  return (
    <div className="walletbar" aria-label="选手钱包余额">
      <span className="walletbar-label">选手筹码 <span>CHIP BALANCE</span></span>
      <div className="walletbar-list">
        {ordered.map(({ wallet, bot }, index) => {
          if (!wallet) return null;
          const change = pulse[wallet.id];
          const fresh = Boolean(change && now - change.at < 3000);
          const direction = fresh ? (change!.delta > 0 ? 'up' : 'down') : '';
          return (
            <div key={wallet.id} className={`wchip ${direction}`}>
              <span className="wallet-avatar" data-tone={index % 5}>{bot?.displayName.slice(0, 1) ?? wallet.display_name.slice(0, 1)}</span>
              <span className="wallet-ident"><strong>{bot?.displayName ?? wallet.display_name}</strong><small>{bot?.persona ?? '外部选手'}</small></span>
              <span className="wallet-value"><strong>{coins(wallet.balance_cents)}</strong><small>筹码</small></span>
              {fresh && <span className={`wallet-delta ${change!.delta > 0 ? 'win' : 'lose'}`}>{change!.delta > 0 ? '↗' : '↘'}</span>}
            </div>
          );
        })}
        {wallets.length === 0 && <span className="walletbar-empty">等待选手入座…</span>}
      </div>
    </div>
  );
}
