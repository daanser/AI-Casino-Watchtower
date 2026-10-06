import { useEffect, useMemo, useRef, useState } from 'react';
import type { PublicRound, RoundEvent } from '../lib/types';
import { coins, gameIcon, gameLabel, netClass, signedCoins } from '../lib/format';

/** 事件 → 人话（回放用，比实时流更详细） */
function describe(e: RoundEvent): string {
  const p = e.payload ?? {};
  switch (e.type) {
    case 'reasoning':
      return String(p.text ?? '');
    case 'bet_placed':
      return `下注，押 ${p.bet}`;
    case 'wheel_spin':
      return '轮盘开始转动';
    case 'ball_drop':
      return `小球落在 ${p.winning} 号（${p.color}）`;
    case 'reels_loaded':
      return '转轴就绪';
    case 'reel_stop':
      return `第 ${Number(p.reel) + 1} 轴停在 ${p.label}`;
    case 'result':
      return Number(p.multiplier) > 0 ? `中奖 ${p.multiplier} 倍` : '未中奖';
    case 'card_dealt':
      return p.card
        ? `${p.side === 'dragon' ? '龙' : '虎'}方发到 ${(p.card as { rank: string; suit: string }).rank}${(p.card as { rank: string; suit: string }).suit}`
        : '发牌';
    case 'showdown':
      return `比牌：${p.winner}`;
    case 'rocket_launch':
      return '🚀 起飞';
    case 'rocket_progress':
      return `飞到 ${p.multiplier}×`;
    case 'rocket_crash':
      return `💥 崩在 ${p.crashPoint}×`;
    case 'cashout':
      return `落袋 ${p.multiplier}×`;
    case 'deal':
      return p.back ? '庄家扣下暗牌' : `${p.side === 'player' ? '闲家' : '庄家'}发到一张牌`;
    case 'reveal':
      return '庄家翻开暗牌';
    case 'bust':
      return `爆牌（${p.total} 点）`;
    case 'double':
      return '加倍';
    case 'blackjack':
      return '黑杰克！';
    default:
      return e.type;
  }
}

export function Replay({ onClose }: { onClose: () => void }) {
  const [rounds, setRounds] = useState<PublicRound[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [events, setEvents] = useState<RoundEvent[]>([]);
  const [verify, setVerify] = useState<{ ok: boolean; serverSeed: string } | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/v1/rounds?limit=40');
        if (!res.ok) return;
        const rows = (await res.json()) as PublicRound[];
        setRounds(rows);
        const firstSettled = rows.find((r) => r.status === 'settled');
        if (firstSettled) setSelected(firstSettled.id);
      } catch {
        /* 静默 */
      }
    })();
  }, []);

  useEffect(() => {
    if (selected === null) return;
    setCursor(0);
    setPlaying(false);
    setVerify(null);
    void (async () => {
      try {
        const res = await fetch(`/api/v1/rounds/${selected}/events`);
        if (!res.ok) return;
        setEvents((await res.json()) as RoundEvent[]);
      } catch {
        /* 静默 */
      }
    })();
  }, [selected]);

  // 播放：按事件的 atMs 节奏逐步揭示
  useEffect(() => {
    if (!playing || cursor >= events.length) {
      if (playing && cursor >= events.length) setPlaying(false);
      return;
    }
    const cur = events[cursor];
    const next = events[cursor + 1];
    const gap = next ? Math.max(60, Math.min(next.atMs - (cur?.atMs ?? 0), 900)) : 200;
    timer.current = setTimeout(() => setCursor((c) => c + 1), gap);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [playing, cursor, events]);

  const round = useMemo(() => rounds.find((r) => r.id === selected) ?? null, [rounds, selected]);
  const shown = events.slice(0, cursor);

  const doVerify = async () => {
    if (selected === null) return;
    try {
      const res = await fetch(`/api/v1/rounds/${selected}/verify`);
      if (!res.ok) return;
      const v = (await res.json()) as { ok: boolean; serverSeed: string };
      setVerify(v);
    } catch {
      /* 静默 */
    }
  };

  return (
    <div className="replay" onClick={onClose}>
      <div className="replay-box" onClick={(e) => e.stopPropagation()}>
        <div className="replay-head">
          <span className="ttl">🔍 回放一局</span>
          <select
            value={selected ?? ''}
            onChange={(e) => setSelected(Number(e.target.value))}
            style={{
              padding: '4px 8px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--panel-2)',
              fontSize: 12,
              maxWidth: 300,
            }}
          >
            {rounds.map((r) => (
              <option key={r.id} value={r.id}>
                #{r.id} {gameLabel(r.gameId)} · 注 {coins(r.betCents)} ·{' '}
                {r.status === 'settled' ? signedCoins(r.netCents) : r.status}
              </option>
            ))}
          </select>
          <button onClick={onClose}>关闭</button>
        </div>

        <div className="replay-body">
          {round && (
            <div
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                marginBottom: 12,
                paddingBottom: 10,
                borderBottom: '1px solid var(--border)',
              }}
            >
              <span style={{ fontSize: 22 }}>{gameIcon(round.gameId)}</span>
              <div>
                <div style={{ fontWeight: 650 }}>{gameLabel(round.gameId)}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  钱包 #{round.walletId} · 注 {coins(round.betCents)} · 派彩{' '}
                  {coins(round.payoutCents)} ·{' '}
                  <b className={netClass(round.netCents)}>{signedCoins(round.netCents)}</b>
                </div>
              </div>
              <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                <div style={{ fontSize: 10.5, color: 'var(--faint)' }}>开局承诺</div>
                <div className="mono" style={{ fontSize: 10 }}>
                  {round.seedCommit.slice(0, 16)}…
                </div>
              </div>
            </div>
          )}

          {events.length === 0 ? (
            <div className="empty">这一局还没有事件。</div>
          ) : (
            shown.map((e) => (
              <div key={e.seq} className={`tl-item ${e.type === 'reasoning' ? 'reason' : ''}`}>
                <span className="at">{(e.atMs / 1000).toFixed(1)}s</span>
                <span className="txt">
                  {e.type === 'reasoning' && '💭 '}
                  {describe(e)}
                </span>
              </div>
            ))
          )}
          {shown.length < events.length && (
            <div className="tl-item">
              <span className="at" />
              <span className="txt" style={{ color: 'var(--faint)' }}>
                …还有 {events.length - shown.length} 条
              </span>
            </div>
          )}
        </div>

        <div className="replay-foot">
          <button
            className="btn primary"
            onClick={() => {
              if (cursor >= events.length) setCursor(0);
              setPlaying(true);
            }}
            disabled={events.length === 0}
          >
            {playing ? '播放中…' : cursor >= events.length ? '重播' : '播放'}
          </button>
          <button className="btn" onClick={() => setCursor(events.length)}>
            全部展开
          </button>
          <button className="btn" onClick={doVerify}>
            验算公平性
          </button>
          {verify && (
            <span
              className={verify.ok ? 'win' : 'lose'}
              style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}
            >
              {verify.ok ? '✅ 种子一致' : '❌ 种子不符'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
