import type { RouletteView } from '../../lib/types';
import { betLabel, rouletteColor } from '../../lib/format';

/** 轮盘：押注位 + 开出的小球 */
export function RouletteStage({ view }: { view: RouletteView }) {
  const revealed = Boolean(view.revealed);
  const n = view.winning;
  const color = n !== undefined ? rouletteColor(n) : 'green';

  return (
    <>
      <div className="wheel-wrap">
        {revealed && n !== undefined ? (
          <div className={`pocket ${color}`}>{n}</div>
        ) : (
          <div className="pocket green spin" style={{ opacity: 0.35 }}>
            ?
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="bet-chip">押 {betLabel(view.bet)}</span>
          {revealed && n !== undefined && (
            <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
              开出 <b className={color === 'red' ? 'win' : 'lose'}>{n}</b>
              <span style={{ marginLeft: 6 }}>
                {color === 'red' ? '红' : color === 'black' ? '黑' : '绿'}
              </span>
            </span>
          )}
        </div>
      </div>
    </>
  );
}
