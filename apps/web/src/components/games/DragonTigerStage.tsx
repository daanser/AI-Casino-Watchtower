import type { DragonTigerView, DtCard } from '../../lib/types';
import { betLabel, isRedSuit } from '../../lib/format';

function DtCardView({ card }: { card?: DtCard }) {
  if (!card) {
    return <div className="pcard back" />;
  }
  const red = isRedSuit(card.suit);
  return (
    <div className={`pcard deal ${red ? 'red' : 'black'}`}>
      <span className="r">{card.label}</span>
      <span className="s">{card.suit}</span>
    </div>
  );
}

/** 龙虎斗：两张牌比大小 */
export function DragonTigerStage({ view }: { view: DragonTigerView }) {
  const revealed = Boolean(view.revealed);
  const winner = view.winner;

  return (
    <>
      <div className="dt">
        <div className={`dt-side ${revealed && winner === 'dragon' ? 'win' : ''}`}>
          <span className="lbl">龙</span>
          <DtCardView card={view.dragon} />
        </div>
        <span className="dt-vs">VS</span>
        <div className={`dt-side ${revealed && winner === 'tiger' ? 'win' : ''}`}>
          <span className="lbl">虎</span>
          <DtCardView card={view.tiger} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
        <span className="bet-chip">押 {betLabel(view.bet)}</span>
        {revealed && (
          <span className="mono" style={{ fontSize: 12 }}>
            {winner === 'tie' ? (
              <span className="push">和局</span>
            ) : winner === 'dragon' ? (
              <span className="win">龙胜</span>
            ) : (
              <span className="win">虎胜</span>
            )}
          </span>
        )}
      </div>
    </>
  );
}
