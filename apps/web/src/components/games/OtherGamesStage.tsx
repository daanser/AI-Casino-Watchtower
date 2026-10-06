import type { Card } from '../../lib/types';
import { betLabel } from '../../lib/format';
import { PCard } from './Card';

type View = Record<string, unknown>;

const cardArray = (v: unknown): Card[] => (Array.isArray(v) ? (v as Card[]) : []);

function Cards({
  cards,
  hidden = false,
  hiddenCount = 0,
}: {
  cards: Card[];
  hidden?: boolean;
  hiddenCount?: number;
}) {
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', minHeight: 50 }}>
      {cards.map((c, i) => <PCard key={i} card={c} size="sm" animate={i > 1} />)}
      {hidden && <PCard card={null} hidden size="sm" />}
      {Array.from({ length: hiddenCount }, (_, i) => <PCard key={`h${i}`} card={null} hidden size="sm" />)}
    </div>
  );
}

function BaccaratStage({ view }: { view: View }) {
  const player = cardArray(view.player);
  const banker = cardArray(view.banker);
  return (
    <>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
        <div className="other-hand"><b>闲 {view.revealed ? `· ${view.playerTotal}` : ''}</b><Cards cards={player} /></div>
        <span className="dt-vs">VS</span>
        <div className="other-hand"><b>庄 {view.revealed ? `· ${view.bankerTotal}` : ''}</b><Cards cards={banker} /></div>
      </div>
      <span className="bet-chip">押 {betLabel(view.bet)}</span>
      {view.revealed && <b className={view.winner === 'tie' ? 'push' : 'win'}>{view.winner === 'tie' ? '和局' : `${view.winner === 'player' ? '闲' : '庄'}胜`}</b>}
    </>
  );
}

function SicboStage({ view }: { view: View }) {
  const dice = Array.isArray(view.dice) ? (view.dice as number[]) : [];
  return (
    <>
      <span className="bet-chip">押 {String(view.betLabel ?? betLabel(view.bet))}</span>
      <div className="dice-row">
        {[0, 1, 2].map((i) => <span className={`die ${dice[i] ? 'die-hit' : ''}`} key={i}>{dice[i] ?? '?'}</span>)}
      </div>
      <b className="mono">{view.revealed ? `和值 ${view.total}` : '等待掷骰…'}</b>
      {view.isTriple && <span className="win">三同号（外围注通吃）</span>}
    </>
  );
}

function WheelStage({ view }: { view: View }) {
  const table = Array.isArray(view.table) ? (view.table as { mult: number; weight: number }[]) : [];
  const i = Number(view.landedIndex ?? -1);
  return (
    <>
      <div className="wheel-segments">
        {table.map((seg, idx) => <div key={idx} className={`wheel-segment ${i === idx ? 'wheel-hit' : ''}`}>{seg.mult === 0 ? '空' : `${seg.mult}×`}</div>)}
      </div>
      <b className={Number(view.multiplier) > 1 ? 'win mono' : 'mono'}>{view.revealed ? `停在 ${Number(view.multiplier).toFixed(2)}×` : '转盘旋转中…'}</b>
    </>
  );
}

function PlinkoStage({ view }: { view: View }) {
  const path = Array.isArray(view.path) ? (view.path as string[]) : [];
  const payouts = Array.isArray(view.payouts) ? (view.payouts as number[]) : [];
  const slot = Number(view.slot ?? -1);
  return (
    <>
      <div className="plinko-path">{path.length === 0 ? '🔵' : path.map((d, i) => <span key={i}>{d === 'right' ? '↘' : '↙'}</span>)}</div>
      <div className="wheel-segments">{payouts.map((mult, idx) => <div key={idx} className={`wheel-segment ${slot === idx ? 'wheel-hit' : ''}`}>{mult}×</div>)}</div>
      <b className="mono">{view.revealed ? `落点 ${slot + 1} · ${view.multiplier}×` : `风险：${view.risk ?? 'medium'}`}</b>
    </>
  );
}

function KenoStage({ view }: { view: View }) {
  const picks = new Set((Array.isArray(view.picks) ? view.picks : []) as number[]);
  const drawn = new Set((Array.isArray(view.drawn) ? view.drawn : []) as number[]);
  const hits = new Set((Array.isArray(view.hits) ? view.hits : []) as number[]);
  return (
    <>
      <div className="keno-grid">{Array.from({ length: 80 }, (_, i) => i + 1).map((n) => <span key={n} className={`keno-num ${picks.has(n) ? 'keno-pick' : ''} ${drawn.has(n) ? 'keno-drawn' : ''} ${hits.has(n) ? 'keno-hit' : ''}`}>{n}</span>)}</div>
      <b className="mono">{view.revealed ? `命中 ${view.hitCount} 个 · ${view.multiplier}×` : `自选号码：${[...picks].join(' · ')}`}</b>
    </>
  );
}

function CrapsStage({ view }: { view: View }) {
  const rolls = Array.isArray(view.rolls) ? (view.rolls as number[][]) : [];
  const dice = Array.isArray(view.lastDice) ? (view.lastDice as number[]) : [];
  return (
    <>
      <div className="dice-row">{[0, 1].map((i) => <span className="die" key={i}>{dice[i] ?? '?'}</span>)}</div>
      <b className="mono">{view.finished ? (view.won ? '过线赢了' : '七出 / 首掷输') : view.point ? `Point = ${view.point} · 再掷中点赢，掷 7 输` : 'Come-out：掷 7/11 赢，2/3/12 输'}</b>
      <span style={{ color: 'var(--muted)', fontSize: 11 }}>已掷 {rolls.length} 次</span>
    </>
  );
}

function HoldemStage({ view }: { view: View }) {
  const revealed = Boolean(view.revealed);
  const decision = String(view.decision ?? 'pending');
  const dealt = revealed && decision === 'call';
  // 牌型名字有两个来源：事件流里的 showdown（字符串）与结算时的权威局面（对象）。
  // 两条路都要认，否则断线重连或漏帧时会只剩「你赢了」三个字，看不出赢在哪。
  const handName = (flat: unknown, nested: unknown) =>
    String((flat as string | undefined) ?? (nested as { name?: string } | undefined)?.name ?? '');
  const playerHandName = handName(view.playerHandName, view.playerHand);
  const dealerHandName = handName(view.dealerHandName, view.dealerHand);
  return (
    <>
      {/* 底牌与庄家并排：德州扑克有四行信息，三行叠着放会被 .stage 的 overflow:hidden 切掉结局 */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
        <div className="other-hand"><b>我的底牌</b><Cards cards={cardArray(view.player)} /></div>
        <div className="other-hand">
          <b>庄家{dealt && dealerHandName ? ` · ${dealerHandName}` : ''}</b>
          {/* 翻牌前只给背面 —— 庄家的两张牌在结算前不该出现在画面上 */}
          {dealt
            ? <Cards cards={cardArray(view.dealer)} />
            : <Cards cards={[]} hiddenCount={Number(view.dealerCardCount ?? 2)} />}
        </div>
      </div>
      <div className="other-hand"><b>公共牌</b><Cards cards={cardArray(view.board)} /></div>
      {dealt && (
        <b className={view.winner === 'player' ? 'win' : 'push'}>
          {view.winner === 'player' ? '你赢了' : view.winner === 'tie' ? '平局' : '庄家赢'}
          {playerHandName ? ` · ${playerHandName} 对 ${dealerHandName}` : ''}
        </b>
      )}
      {revealed && decision === 'fold' && <b className="push">已弃牌 · 输掉注额</b>}
      {!revealed && <span className="bet-chip">可选：弃牌 / 跟注</span>}
    </>
  );
}

function VideoPokerStage({ view }: { view: View }) {
  const hand = cardArray(view.hand);
  const held = new Set((Array.isArray(view.held) ? view.held : []) as number[]);
  return (
    <>
      <div style={{ display: 'flex', gap: 5 }}>{hand.map((c, i) => <div key={i} style={{ textAlign: 'center' }}><PCard card={c} animate={Boolean(view.revealed && !held.has(i))} /><small style={{ color: held.has(i) ? 'var(--accent)' : 'var(--muted)', fontSize: 10 }}>{held.has(i) ? '保留' : i + 1}</small></div>)}</div>
      <b className={Number(view.multiplier) > 0 ? 'win' : 'push'}>{view.revealed ? `${view.handName} · ${view.multiplier}×` : '挑选要保留的牌'}</b>
    </>
  );
}

function HiLoStage({ view }: { view: View }) {
  const card = view.current as Card | undefined;
  const probabilities = (view.probabilities ?? {}) as { higher?: number; lower?: number };
  return (
    <>
      {card ? <PCard card={card} /> : <div className="pcard back" />}
      <div className="mono" style={{ fontWeight: 700 }}>{view.revealed ? (view.won ? '你赢了' : '猜错了') : `当前返还 ${(Number(view.multiplier) * 100).toFixed(0)}%`}</div>
      {!view.revealed && <div style={{ color: 'var(--muted)', fontSize: 11 }}>高 {(Number(probabilities.higher ?? 0) * 100).toFixed(0)}% · 低 {(Number(probabilities.lower ?? 0) * 100).toFixed(0)}% · 已猜 {Number(view.guesses ?? 0)}/{Number(view.maxGuesses ?? 0)}</div>}
      {view.revealed && view.nextCard && <span>下一张：{(view.nextCard as Card).rank}{(view.nextCard as Card).suit}</span>}
    </>
  );
}

export function OtherGamesStage({ gameId, view }: { gameId: string; view: View }) {
  switch (gameId) {
    case 'baccarat': return <BaccaratStage view={view} />;
    case 'sicbo': return <SicboStage view={view} />;
    case 'wheel': return <WheelStage view={view} />;
    case 'plinko': return <PlinkoStage view={view} />;
    case 'keno': return <KenoStage view={view} />;
    case 'craps': return <CrapsStage view={view} />;
    case 'holdem': return <HoldemStage view={view} />;
    case 'video-poker': return <VideoPokerStage view={view} />;
    case 'hi-lo': return <HiLoStage view={view} />;
    default: return <div className="empty">暂未支持：{gameId}</div>;
  }
}
