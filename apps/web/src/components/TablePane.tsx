import type { BotStatus, TableRuntime } from '../lib/types';
import { coins, gameIcon, gameLabel, netClass, signedCoins } from '../lib/format';
import { SlotsStage } from './games/SlotsStage';
import { RouletteStage } from './games/RouletteStage';
import { DragonTigerStage } from './games/DragonTigerStage';
import { CrashStage } from './games/CrashStage';
import { BlackjackStage } from './games/BlackjackStage';
import { OtherGamesStage } from './games/OtherGamesStage';
import type { BjView, CrashView, DragonTigerView, RouletteView, SlotsView } from '../lib/types';

/** 最近几局的走势：红赢、绿输，按真实时间从左往右排。 */
function Spark({ history }: { history: TableRuntime['history'] }) {
  if (history.length < 2) return <span className="spark-placeholder">等待更多对局</span>;
  const recent = history.slice(0, 12).reverse();
  const max = Math.max(...recent.map((r) => Math.abs(r.netCents)), 1);
  return (
    <div className="spark" title="最近 12 局净收益（红赢绿输）" aria-label="最近对局走势">
      {recent.map((r) => (
        <i
          key={r.roundId}
          style={{
            height: `${Math.max(4, Math.round((Math.abs(r.netCents) / max) * 24))}px`,
            background: r.netCents > 0 ? 'var(--win)' : r.netCents < 0 ? 'var(--lose)' : 'var(--faint)',
          }}
        />
      ))}
    </div>
  );
}

function Stage({ table }: { table: TableRuntime }) {
  if (table.roundId === null) {
    return <div className="stage-idle"><span aria-hidden="true">{gameIcon(table.gameId)}</span><strong>即将开局</strong><small>等待 AI 做出下一次选择</small></div>;
  }

  const v = table.view;
  switch (table.gameId) {
    case 'slots': return <SlotsStage view={v as unknown as SlotsView} />;
    case 'roulette': return <RouletteStage view={v as unknown as RouletteView} />;
    case 'dragon-tiger': return <DragonTigerStage view={v as unknown as DragonTigerView} />;
    case 'crash': return <CrashStage view={v as unknown as CrashView} roundId={table.roundId} running={table.status === 'running'} />;
    case 'blackjack': return <BlackjackStage view={v as unknown as BjView} />;
    default: return <OtherGamesStage gameId={table.gameId} view={v} />;
  }
}

export function TablePane({
  table,
  bot,
  slotNumber,
  balanceCents,
  walletName,
}: {
  table: TableRuntime;
  bot?: BotStatus;
  slotNumber: number;
  balanceCents?: number;
  walletName: (id: number | null) => string;
}) {
  const live = table.status === 'running';
  const result = table.lastResult;
  const displayName = bot?.displayName ?? table.displayName ?? walletName(table.walletId);
  const recentSwitch = table.gameSwitch?.toGameId === table.gameId ? table.gameSwitch : null;

  return (
    <article className={`pane ${live ? 'live' : ''} ${bot ? 'bot-slot' : ''}`} data-tone={(slotNumber - 1) % 5}>
      <div className="pane-identity">
        <div className="player-avatar" aria-hidden="true">{displayName === '—' ? '?' : displayName.slice(0, 1)}</div>
        <div className="player-copy"><strong>{displayName}</strong><span>{bot?.persona ?? '自由选手'}</span></div>
        <div className="seat-number">SEAT {String(slotNumber).padStart(2, '0')}</div>
      </div>

      <div className="pane-head">
        <div className="game-title"><span className="game-symbol" aria-hidden="true">{gameIcon(table.gameId)}</span><div><span className="game-caption">CURRENT GAME</span><h3>{gameLabel(table.gameId)}</h3></div></div>
        <span className={`table-status ${live ? 'is-live' : ''}`}><i />{live ? '对局中' : table.status === 'settled' ? '已结算' : '待开局'}</span>
      </div>

      <div className="stage"><Stage table={table} /></div>

      {recentSwitch && (
        <div className="switch-callout" title={recentSwitch.reason}>
          <span className="switch-arrow" aria-hidden="true">↗</span>
          <span><strong>自主切换 · {gameLabel(recentSwitch.fromGameId)} → {gameLabel(recentSwitch.toGameId)}</strong><small>{recentSwitch.reason}</small></span>
        </div>
      )}

      <div className="pane-reason">
        <div className="reason-label"><span aria-hidden="true">✳</span> AI 的想法</div>
        <p>
          {table.reasoning
            ? // 不是选手自己说的就标出说话人 —— realtime 游戏里「庄家」会替玩家
              // 走完最后一步（大火箭到点自动炸），那句话不该被当成 AI 的想法
              table.reasoning.actor && table.reasoning.actor !== displayName
              ? `${table.reasoning.actor}：${table.reasoning.text}`
              : table.reasoning.text
            : '正在思考下一步…'}
        </p>
      </div>

      <div className="pane-foot">
        <div className="pane-metric"><span>余额</span><strong>{balanceCents !== undefined ? coins(balanceCents) : '—'}</strong></div>
        <div className="pane-metric"><span>本局下注</span><strong>{table.betCents > 0 ? coins(table.betCents) : '—'}</strong></div>
        <div className="pane-metric"><span>最近结果</span><strong className={result ? netClass(result.netCents) : ''}>{result ? signedCoins(result.netCents) : '—'}</strong></div>
        <div className="pane-trend"><span>走势</span><Spark history={table.history} /></div>
      </div>
    </article>
  );
}
