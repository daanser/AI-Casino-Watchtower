import type { SlotsView } from '../../lib/types';

const SYMBOL_LABEL: Record<number, string> = {
  0: '🍒',
  1: '🍋',
  2: '🔔',
  3: '⭐',
  4: '💎',
  5: '7️⃣',
};

const PLACEHOLDER = '❔';

/**
 * 老虎机：三个转轴依次停下。
 * 没收到 reel_stop 之前那一轴就在「转」——所以是按帧驱动的，
 * 不是前端自己随便转。
 */
export function SlotsStage({ view }: { view: SlotsView }) {
  const labels = view.labels;
  const reels = view.reels;
  const revealed = Boolean(view.revealed);
  const multiplier = Number(view.multiplier ?? 0);
  const hit = revealed && multiplier > 0;

  const shown: string[] = [0, 1, 2].map((i) => {
    if (labels?.[i]) return labels[i] as string;
    if (reels?.[i] !== undefined && reels[i] >= 0) return SYMBOL_LABEL[reels[i]] ?? PLACEHOLDER;
    return PLACEHOLDER;
  });

  const stopped = [0, 1, 2].map((i) => Boolean(labels?.[i] || (reels?.[i] ?? -1) >= 0));

  return (
    <>
      <div className="reels">
        {shown.map((label, i) => (
          <div
            key={i}
            className={[
              'reel',
              stopped[i] ? '' : 'spinning',
              hit && stopped[i] ? 'hit' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {label}
          </div>
        ))}
      </div>
      <div className="mult">
        {revealed ? (
          multiplier > 0 ? (
            <span className="win">中奖 {multiplier}×</span>
          ) : (
            <span className="push">未中奖</span>
          )
        ) : (
          <span className="push">转动中…</span>
        )}
      </div>
    </>
  );
}
