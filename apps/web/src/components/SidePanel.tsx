import { useEffect, useMemo, useState } from 'react';
import type { BotStatus, FeedItem, ReasoningItem, WalletRow } from '../lib/types';
import { coins, gameIcon, gameLabel, hhmmss, netClass, signedCoins } from '../lib/format';

// ── 事件流 ───────────────────────────────────────────────────

export function FeedList({ feed, onClear }: { feed: FeedItem[]; onClear: () => void }) {
  return (
    <>
      <div className="side-head"><span className="h">实时播报</span><span className="side-count">{feed.length} 条</span><button type="button" onClick={onClear}>清空</button></div>
      {feed.length === 0 ? (
        <div className="empty"><span className="big">◎</span>还没有事件。等 AI 们开始下注。</div>
      ) : (
        <div className="feed-list">
          {feed.map((f) => (
            <div key={f.id} className={`feed-item k-${f.kind}`}>
              <div className="feed-icon" aria-hidden="true">{f.kind === 'switch' ? '↗' : f.kind === 'settled' ? '✓' : f.kind === 'wallet' ? '◈' : gameIcon(f.gameId)}</div>
              <div className="feed-content">
                <div className="feed-meta"><span>{f.kind === 'switch' ? '自主换桌' : f.kind === 'settled' ? '对局结算' : f.kind === 'start' ? '新局开始' : f.kind === 'wallet' ? '筹码变动' : gameLabel(f.gameId)}</span><time>{hhmmss(f.at)}</time></div>
                <div className="feed-text">{f.text.replace(/^🔔 明确提示：/, '')}{f.netCents !== undefined && <b className={`mono ${netClass(f.netCents)}`}> {signedCoins(f.netCents)}</b>}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── 推理流（「我为什么这么打」）────────────────────────────────

export function ReasoningList({ items }: { items: ReasoningItem[] }) {
  return (
    <>
      <div className="side-head">
        <span className="h">💭 AI 决策理由</span>
      </div>
      {items.length === 0 ? (
        <div className="empty">
          <span className="big">💭</span>
          还没有 AI 自述决策理由。
          <br />
          接入的 agent 每次出牌都可以写一句「我为什么这么打」。
        </div>
      ) : (
        items.map((r) => (
          <div key={r.id} className="reason-item">
            <div className="top">
              <span>{gameIcon(r.gameId)}</span>
              <span className="who">{r.actor}</span>
              <span className="when">{hhmmss(r.at)}</span>
            </div>
            <div className="txt">{r.text}</div>
          </div>
        ))
      )}
    </>
  );
}

// ── 排行榜 ───────────────────────────────────────────────────

interface WalletStat {
  walletId: number;
  name: string;
  balanceCents: number;
  rounds: number;
  betCents: number;
  payoutCents: number;
}

export function Leaderboard({ wallets }: { wallets: WalletRow[] }) {
  const [stats, setStats] = useState<Map<number, { rounds: number; bet: number; payout: number }>>(
    new Map(),
  );

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/v1/rounds?limit=200');
        if (!res.ok) return;
        const rows = (await res.json()) as {
          walletId: number;
          betCents: number;
          payoutCents: number;
        }[];
        const m = new Map<number, { rounds: number; bet: number; payout: number }>();
        for (const r of rows) {
          const s = m.get(r.walletId) ?? { rounds: 0, bet: 0, payout: 0 };
          s.rounds += 1;
          s.bet += r.betCents;
          s.payout += r.payoutCents;
          m.set(r.walletId, s);
        }
        if (alive) setStats(m);
      } catch {
        /* 静默 */
      }
    };
    void load();
    const id = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const board: WalletStat[] = useMemo(
    () =>
      wallets
        .map((w) => {
          const s = stats.get(w.id);
          return {
            walletId: w.id,
            name: w.display_name,
            balanceCents: w.balance_cents,
            rounds: s?.rounds ?? 0,
            betCents: s?.bet ?? 0,
            payoutCents: s?.payout ?? 0,
          };
        })
        .sort((a, b) => b.balanceCents - a.balanceCents),
    [wallets, stats],
  );

  return (
    <>
      <div className="side-head">
        <span className="h">🏆 排行榜（按余额）</span>
      </div>
      {board.length === 0 ? (
        <div className="empty">
          <span className="big">🏆</span>
          还没有玩家。
        </div>
      ) : (
        board.map((w, i) => {
          const rtp = w.betCents > 0 ? w.payoutCents / w.betCents : null;
          return (
            <div key={w.walletId} className="lb-row">
              <span className={`rk ${i < 3 ? 'top' : ''}`}>{i + 1}</span>
              <span className="nm">
                {w.name}
                <div className="meta">
                  {w.rounds} 局
                  {rtp !== null ? ` · RTP ${(rtp * 100).toFixed(1)}%` : ''}
                </div>
              </span>
              <span className="bal">{coins(w.balanceCents)}</span>
            </div>
          );
        })
      )}
    </>
  );
}

// ── AI 档案 ──────────────────────────────────────────────────

export function AgentProfile({
  bots,
  wallets,
  walletName,
}: {
  bots: BotStatus[];
  wallets: WalletRow[];
  walletName: (id: number | null) => string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [rounds, setRounds] = useState<
    { id: number; gameId: string; netCents: number; betCents: number; payoutCents: number; status: string }[]
  >([]);

  const bot = bots.find((b) => b.id === selected) ?? bots[0] ?? null;

  useEffect(() => {
    if (!bot) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/v1/rounds?limit=40&walletId=${bot.walletId}`);
        if (!res.ok) return;
        const rows = (await res.json()) as typeof rounds;
        if (alive) setRounds(rows);
      } catch {
        /* 静默 */
      }
    };
    void load();
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [bot]);

  if (!bot) {
    return (
      <div className="empty">
        <span className="big">🤖</span>
        还没有上场的 AI。
      </div>
    );
  }

  const settled = rounds.filter((r) => r.status === 'settled');
  const wins = settled.filter((r) => r.netCents > 0).length;
  const losses = settled.filter((r) => r.netCents < 0).length;
  const totalNet = settled.reduce((a, r) => a + r.netCents, 0);
  const wallet = wallets.find((w) => w.id === bot.walletId);
  const winRate = settled.length > 0 ? (wins / settled.length) * 100 : 0;

  return (
    <>
      <div className="side-head">
        <span className="h">🤖 AI 档案</span>
      </div>

      <div style={{ display: 'flex', gap: 5, padding: '8px 12px', flexWrap: 'wrap' }}>
        {bots.map((b) => (
          <button
            key={b.id}
            className={`btn ${b.id === bot.id ? 'primary' : ''}`}
            style={{ fontSize: 11, padding: '3px 9px' }}
            onClick={() => setSelected(b.id)}
          >
            {b.displayName}
          </button>
        ))}
      </div>

      <div className="profile">
        <div className="who">
          <div className="avatar">{bot.displayName.slice(0, 1)}</div>
          <div>
            <div className="nm">{bot.displayName}</div>
            <div className="persona">{bot.persona}</div>
          </div>
        </div>

        <div className="stats">
          <div className="stat">
            <div className="k">余额</div>
            <div className="v">{coins(wallet?.balance_cents ?? 0)}</div>
          </div>
          <div className="stat">
            <div className="k">累计净收益</div>
            <div className={`v ${netClass(totalNet)}`}>{signedCoins(totalNet)}</div>
          </div>
          <div className="stat">
            <div className="k">已结算局数</div>
            <div className="v">{settled.length}</div>
          </div>
          <div className="stat">
            <div className="k">胜率</div>
            <div className="v">{winRate.toFixed(0)}%</div>
          </div>
          <div className="stat">
            <div className="k">赢 / 输</div>
            <div className="v">
              <span className="win">{wins}</span> / <span className="lose">{losses}</span>
            </div>
          </div>
          <div className="stat">
            <div className="k">主玩</div>
            <div className="v" style={{ fontSize: 12 }}>
              {gameIcon(bot.gameId)} {gameLabel(bot.gameId)}
            </div>
          </div>
        </div>

        <div className="sec">最近对局</div>
        {settled.slice(0, 12).map((r) => (
          <div key={r.id} className="mini-round">
            <span className="g">{gameIcon(r.gameId)}</span>
            <span style={{ color: 'var(--faint)', fontFamily: 'var(--mono)', fontSize: 11 }}>
              #{r.id}
            </span>
            <span className="n">
              注 {coins(r.betCents)} →{' '}
              <b className={netClass(r.netCents)}>{signedCoins(r.netCents)}</b>
            </span>
          </div>
        ))}
        {settled.length === 0 && <div className="empty">还没有结算过的对局。</div>}
      </div>
    </>
  );
}

/** 侧栏容器：四个页签 */
export function SidePanel({
  feed,
  onClearFeed,
  reasonings,
  wallets,
  bots,
  walletName,
}: {
  feed: FeedItem[];
  onClearFeed: () => void;
  reasonings: ReasoningItem[];
  wallets: WalletRow[];
  bots: BotStatus[];
  walletName: (id: number | null) => string;
}) {
  const [tab, setTab] = useState<'feed' | 'reason' | 'board' | 'bot'>('feed');
  const latestSwitch = feed.find((item) => item.kind === 'switch');
  const tabs = [
    { id: 'feed', label: '现场', count: feed.length },
    { id: 'reason', label: '想法', count: reasonings.length },
    { id: 'board', label: '排行', count: null },
    { id: 'bot', label: '选手', count: null },
  ] as const;
  return (
    <aside className="side" aria-label="现场侧栏">
      <div className="side-intro"><span>02 / LIVE JOURNAL</span><h2>场边速报<span className="side-live-dot" /></h2><p>每个决定，都有迹可循。</p></div>
      {latestSwitch && <div className="side-switch" role="status"><span className="side-switch-caption">↗ 最近一次自主换桌</span><p>{latestSwitch.text.replace(/^🔔 明确提示：/, '')}</p></div>}
      <div className="side-tabs" role="tablist" aria-label="侧栏内容">
        {tabs.map(({ id, label, count }) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}{count !== null && <small>{count}</small>}
          </button>
        ))}
      </div>
      <div className="side-body" role="tabpanel">
        {tab === 'feed' && <FeedList feed={feed} onClear={onClearFeed} />}
        {tab === 'reason' && <ReasoningList items={reasonings} />}
        {tab === 'board' && <Leaderboard wallets={wallets} />}
        {tab === 'bot' && <AgentProfile bots={bots} wallets={wallets} walletName={walletName} />}
      </div>
      <div className="side-bottom"><span className="side-bottom-mark">◎</span><span>PROVABLY FAIR<br /><small>每局开局承诺 / 结算揭示</small></span></div>
    </aside>
  );
}
