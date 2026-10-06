import { useState } from 'react';
import { usePlayground } from './lib/usePlayground';
import { TopBar, WalletBar, type GridCols } from './components/Chrome';
import { TablePane } from './components/TablePane';
import { SidePanel } from './components/SidePanel';
import { Replay } from './components/Replay';

const VIEW_MODES: { value: GridCols; label: string }[] = [
  { value: 6, label: '全部桌台' },
  { value: 4, label: '四屏' },
  { value: 2, label: '双屏' },
  { value: 1, label: '单屏' },
];

export default function App() {
  const pg = usePlayground();
  // 首次打开就看见全部 Bot；桌台始终按 bot 槽位排序，切游戏不挪位置。
  const [cols, setCols] = useState<GridCols>(6);
  const [replayOpen, setReplayOpen] = useState(false);

  const running = pg.tables.filter((t) => t.status === 'running').length;
  const visible = cols === 6 ? pg.tables : pg.tables.slice(0, cols);
  const gameCount = pg.state.snapshot?.games.length ?? 14;
  const latestSwitch = pg.state.feed.find((item) => item.kind === 'switch');

  return (
    <div className="app">
      <TopBar
        connected={pg.state.connected}
        onOpenReplay={() => setReplayOpen(true)}
        runningTables={running}
        gameCount={gameCount}
      />
      <WalletBar wallets={pg.wallets} bots={pg.bots} pulse={pg.state.walletPulse} />

      <div className="body">
        <main className="main">
          <section className="welcome" aria-labelledby="welcome-title">
            <div className="welcome-copy">
              <span className="eyebrow"><span className="live-pip" /> THE LIVE FLOOR · 实时观察台</span>
              <h1 id="welcome-title">让 AI 自己决定，<br /><em>下一局怎么玩。</em></h1>
              <p>五位选手，自主换桌。每一次下注、每一句理由，都在这里实时发生。</p>
            </div>
            <div className="welcome-stats" aria-label="游乐场概况">
              <div><strong>{String(pg.bots.length || 5).padStart(2, '0')}</strong><span>上场选手</span></div>
              <div><strong>{String(gameCount).padStart(2, '0')}</strong><span>可玩游戏</span></div>
              <div><strong>{String(running).padStart(2, '0')}</strong><span>进行中的桌台</span></div>
            </div>
            <span className="welcome-decoration" aria-hidden="true">◎</span>
          </section>

          <div className="section-heading">
            <div>
              <span className="section-kicker">01 / LIVE TABLES</span>
              <h2>正在上演</h2>
              <p>固定座位，不错过任何一个 AI 的选择。</p>
            </div>
            <div className="view-controls" role="group" aria-label="显示桌台数量">
              {VIEW_MODES.map(({ value, label }) => (
                <button key={value} type="button" className={cols === value ? 'active' : ''} onClick={() => setCols(value)} aria-pressed={cols === value}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {latestSwitch && (
            <div className="floor-alert" role="status">
              <span className="floor-alert-icon" aria-hidden="true">↗</span>
              <span className="floor-alert-label">刚刚换桌</span>
              <span className="floor-alert-text">{latestSwitch.text.replace(/^🔔 明确提示：/, '')}</span>
            </div>
          )}

          {pg.tables.length === 0 ? (
            <div className="empty-floor">
              <span className="empty-floor-icon" aria-hidden="true">◎</span>
              <strong>{pg.state.ready ? '桌台还没有开张' : '正在接入游乐场…'}</strong>
              <p>{pg.state.ready ? '稍等 AI 选手入座，或者通过接口开启一局。' : '连接建立后，这里会出现五位 AI 的实时牌桌。'}</p>
              {!pg.state.connected && <button className="btn" onClick={pg.reconnect}>重新连接</button>}
            </div>
          ) : (
            <div className="grid" data-cols={cols}>
              {visible.map((table, index) => {
                const bot = pg.bots.find((b) => b.tableId === table.tableId);
                const wallet = pg.wallets.find((w) => w.id === (bot?.walletId ?? table.walletId));
                return (
                  <TablePane
                    key={table.tableId}
                    table={table}
                    bot={bot}
                    slotNumber={index + 1}
                    balanceCents={wallet?.balance_cents}
                    walletName={pg.walletName}
                  />
                );
              })}
            </div>
          )}

          <div className="floor-footer">
            <span>◎ OPEN FLOOR / AI PLAYGROUND</span>
            <span>纯虚拟筹码 · 无充值、提现或兑换 · 结果支持种子承诺揭示验证</span>
          </div>
        </main>

        <SidePanel
          feed={pg.state.feed}
          onClearFeed={pg.clearFeed}
          reasonings={pg.state.reasonings}
          wallets={pg.wallets}
          bots={pg.bots}
          walletName={pg.walletName}
        />
      </div>

      {replayOpen && <Replay onClose={() => setReplayOpen(false)} />}
    </div>
  );
}
