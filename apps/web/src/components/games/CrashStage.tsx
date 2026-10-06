import { useEffect, useRef, useState } from 'react';
import type { CrashView } from '../../lib/types';

const HALF_LIFE_MS = 5000;

/** 与服务端一致的乘数公式：每 5 秒翻一倍 */
function multiplierAt(ms: number): number {
  return Math.round(2 ** (ms / HALF_LIFE_MS) * 100) / 100;
}

function msForMultiplier(m: number): number {
  return Math.round(HALF_LIFE_MS * Math.log2(Math.max(1, m)));
}

/**
 * 大火箭。
 *
 * 服务端只在「收手那一刻」才发 rocket_progress，所以飞行过程要靠前端自己跑。
 * 这不是作弊：乘数曲线是公开确定的（2^(t/5000)），前端算的和服务端算的一定一致；
 * 唯一不知道的是崩溃点，而它直到结算才会揭晓。
 */
export function CrashStage({
  view,
  roundId,
  running,
}: {
  view: CrashView;
  roundId: number | null;
  running: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);
  const t0 = useRef<number>(Date.now());
  const revealed = Boolean(view.revealed);

  // 每一局重新起跳
  useEffect(() => {
    t0.current = Date.now();
    setElapsed(0);
  }, [roundId]);

  useEffect(() => {
    if (revealed || !running) return;
    const id = setInterval(() => setElapsed(Date.now() - t0.current), 60);
    return () => clearInterval(id);
  }, [revealed, running, roundId]);

  // 结算后定格在真实时刻
  const finalMs = revealed
    ? view.busted
      ? msForMultiplier(Number(view.crashPoint ?? 1))
      : Number(view.cashoutAtMs ?? msForMultiplier(Number(view.multiplier ?? 1)))
    : elapsed;

  const displayMs = Math.max(0, revealed ? finalMs : elapsed);
  const current = multiplierAt(displayMs);
  const shownMult = revealed
    ? view.busted
      ? Number(view.crashPoint ?? current)
      : Number(view.multiplier ?? current)
    : current;

  // ── 画曲线 ────────────────────────────────────────────────
  const W = 300;
  const H = 84;
  const xMax = Math.max(displayMs, 6000);
  const yMax = Math.max(2, current * 1.25);

  const pts: string[] = [];
  const STEPS = 48;
  for (let i = 0; i <= STEPS; i += 1) {
    const t = (displayMs * i) / STEPS;
    const m = multiplierAt(t);
    const x = (t / xMax) * W;
    const y = H - (m / yMax) * H;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }

  const last = pts[pts.length - 1]?.split(',') ?? ['0', String(H)];
  const areaPath = `M0,${H} L${pts.join(' L')} L${last[0]},${H} Z`;
  const linePath = `M${pts.join(' L')}`;

  const busted = revealed && Boolean(view.busted);
  const color = busted ? '#dc2626' : '#2563eb';

  return (
    <div className="crash">
      <div className={`crash-mult ${busted ? 'bust' : 'up'}`}>
        {busted ? `${shownMult.toFixed(2)}×` : `${current.toFixed(2)}×`}
      </div>
      <div className="crash-sub">
        {busted ? (
          <span className="win">💥 崩在 {Number(view.crashPoint ?? 0).toFixed(2)}×</span>
        ) : revealed ? (
          <span className="lose">✋ 在 {Number(view.multiplier ?? 0).toFixed(2)}× 落袋</span>
        ) : running ? (
          <span>🚀 飞行中…（{(displayMs / 1000).toFixed(1)}s）</span>
        ) : (
          <span>等待起飞</span>
        )}
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={`cg-${roundId ?? 0}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* 网格 */}
        {[0.25, 0.5, 0.75].map((r) => (
          <line
            key={r}
            x1="0"
            y1={H * r}
            x2={W}
            y2={H * r}
            stroke="#e3e6ea"
            strokeWidth="1"
            strokeDasharray="3 4"
          />
        ))}
        <path d={areaPath} fill={`url(#cg-${roundId ?? 0})`} />
        <path d={linePath} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" />
        <circle cx={Number(last[0])} cy={Number(last[1])} r="3.5" fill={color} />
      </svg>
    </div>
  );
}
