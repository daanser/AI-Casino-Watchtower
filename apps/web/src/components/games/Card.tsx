import type { Card } from '../../lib/types';
import { isRedSuit } from '../../lib/format';

/**
 * 一张扑克牌。hidden = 背面（庄家的暗牌）。
 * key 由调用方给：同一张牌在牌堆里重复出现（6 副牌）是正常的。
 */
export function PCard({
  card,
  hidden,
  size,
  animate,
}: {
  card?: Card | null;
  hidden?: boolean;
  size?: 'sm';
  animate?: boolean;
}) {
  const cls = ['pcard'];
  if (size === 'sm') cls.push('sm');
  if (animate) cls.push('deal');

  if (hidden || !card) {
    cls.push('back');
    return <div className={cls.join(' ')} aria-label="暗牌" />;
  }

  cls.push(isRedSuit(card.suit) ? 'red' : 'black');
  return (
    <div className={cls.join(' ')} aria-label={`${card.rank}${card.suit}`}>
      <span className="r">{card.rank}</span>
      <span className="s">{card.suit}</span>
    </div>
  );
}
