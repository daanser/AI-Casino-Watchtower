import type { BjView, Card } from '../../lib/types';
import { PCard } from './Card';

/**
 * 手牌点数 —— **只在庄家暗牌未翻开时兜底用**。
 *
 * 后端 publicView 已经给出 playerTotal / dealerTotal / playerSoft / playerBlackjack，
 * 那些才是权威值，一律优先用；这个函数只在 `dealerTotal === null`（暗牌还没翻）
 * 时算一下**明牌**的点数给观众看。两处算法必须一致：A 先按 11，爆了再降 10。
 */
function visibleTotal(cards: Card[]): number {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (!c || c.rank === '?') continue;
    if (c.rank === 'A') {
      aces += 1;
      total += 11;
    } else if (c.rank === 'J' || c.rank === 'Q' || c.rank === 'K') {
      total += 10;
    } else {
      total += Number(c.rank) || 0;
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

const ACTION_LABEL: Record<string, string> = {
  hit: '要牌',
  stand: '停牌',
  double: '加倍',
};

/** 黑杰克：庄家与闲家的牌面 */
export function BlackjackStage({ view }: { view: BjView }) {
  const revealed = Boolean(view.revealed);
  const player = (view.player ?? []).filter((c) => c && c.rank !== '?');
  const dealerShown = (view.dealer ?? []).filter((c) => c && c.rank !== '?');
  // 暗牌没翻开之前，庄家手上始终多一张背面
  const dealerCards: (Card | null)[] = revealed ? dealerShown : [...dealerShown, null];

  // 权威点数优先；只有庄家暗牌未翻（dealerTotal 为 null）时才自己算明牌点数。
  const playerTotal = view.playerTotal ?? visibleTotal(player);
  const dealerTotal = view.dealerTotal ?? visibleTotal(dealerShown);

  const playerBust = playerTotal > 21;
  const playerBj = view.playerBlackjack ?? (player.length === 2 && playerTotal === 21);

  return (
    <div className="bj">
      <div className="bj-row">
        <span className="who">庄家</span>
        <div className="hand">
          {dealerCards.map((c, i) => (
            <PCard key={`d${i}`} card={c} hidden={c === null} size="sm" animate={i >= 1} />
          ))}
        </div>
        {dealerShown.length > 0 && (
          <span className={`bj-total ${revealed && dealerTotal > 21 ? 'bust' : ''}`}>
            {dealerTotal}
          </span>
        )}
      </div>

      <div className="bj-row">
        <span className="who">闲家</span>
        <div className="hand">
          {player.map((c, i) => (
            <PCard key={`p${i}`} card={c} size="sm" animate={i >= 2} />
          ))}
        </div>
        {player.length > 0 && (
          <span
            className={`bj-total ${playerBust ? 'bust' : ''} ${playerBj ? 'bj' : ''}`}
          >
            {playerBj ? 'BJ' : playerBust ? `${playerTotal} 爆` : playerTotal}
          </span>
        )}
      </div>

      {!revealed && view.actions?.length > 0 && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--muted)',
            textAlign: 'center',
            marginTop: 2,
          }}
        >
          可选：{view.actions.map((a) => ACTION_LABEL[a] ?? a).join(' / ')}
        </div>
      )}

      {revealed && (
        <div style={{ fontSize: 11, textAlign: 'center', color: 'var(--muted)' }}>
          {playerBust
            ? '闲家爆牌'
            : playerBj
              ? '黑杰克，赔 3:2'
              : dealerTotal > 21
                ? '庄家爆牌'
                : playerTotal > dealerTotal
                  ? '闲家胜'
                  : playerTotal < dealerTotal
                    ? '庄家胜'
                    : '和局'}
        </div>
      )}
    </div>
  );
}
