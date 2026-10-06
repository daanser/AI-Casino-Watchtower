import type { Cents } from './types';

export const CENTS_PER_COIN = 100;

/** 分 → 筹码，带千分位 */
export function coins(c: Cents): string {
  return (c / CENTS_PER_COIN).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/** 带正负号的筹码数 */
export function signedCoins(c: Cents): string {
  const s = coins(Math.abs(c));
  return c > 0 ? `+${s}` : c < 0 ? `−${s}` : '0';
}

/**
 * 中国习惯：赢=红，输=绿。
 * 返回一个语义类名，样式在 css 里定义。
 */
export function netClass(c: Cents): 'win' | 'lose' | 'push' {
  return c > 0 ? 'win' : c < 0 ? 'lose' : 'push';
}

export const GAME_LABEL: Record<string, string> = {
  slots: '老虎机',
  roulette: '欧式轮盘',
  crash: '大火箭',
  blackjack: '黑杰克',
  baccarat: '百家乐',
  sicbo: '骰宝',
  holdem: '德州扑克',
  'video-poker': '视频扑克',
  'dragon-tiger': '龙虎斗',
  wheel: '幸运大转盘',
  plinko: '弹珠台',
  craps: '花旗骰',
  keno: '基诺彩票',
  'hi-lo': '高低猜',
};

export const GAME_ICON: Record<string, string> = {
  slots: '🎰',
  roulette: '🎡',
  crash: '🚀',
  blackjack: '🃏',
  baccarat: '🀄',
  sicbo: '🎲',
  holdem: '♣️',
  'video-poker': '🂡',
  'dragon-tiger': '🐉',
  wheel: '🎯',
  plinko: '🔵',
  craps: '🎲',
  keno: '🔢',
  'hi-lo': '⬆️',
};

export function gameLabel(id: string): string {
  return GAME_LABEL[id] ?? id;
}

export function gameIcon(id: string): string {
  return GAME_ICON[id] ?? '🎲';
}

/** 动作名 → 中文 */
export const ACTION_LABEL: Record<string, string> = {
  spin: '转',
  deal: '开牌',
  cashout: '收手',
  hit: '要牌',
  stand: '停牌',
  double: '加倍',
};

export function hhmmss(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

/** 押注位 → 中文 */
export function betLabel(bet: unknown): string {
  const s = String(bet ?? '');
  const map: Record<string, string> = {
    red: '红',
    black: '黑',
    even: '双',
    odd: '单',
    low: '小 (1-18)',
    high: '大 (19-36)',
    dozen1: '第一打 (1-12)',
    dozen2: '第二打 (13-24)',
    dozen3: '第三打 (25-36)',
    dragon: '龙',
    tiger: '虎',
    tie: '和',
  };
  if (s.startsWith('straight:')) return `单号 ${s.slice(9)}`;
  return map[s] ?? s;
}

/** 牌面颜色：红桃/方块是红的 */
export function isRedSuit(suit: string): boolean {
  return suit === '♥' || suit === '♦';
}

/** 轮盘号码对应的颜色 */
export function rouletteColor(n: number): 'red' | 'black' | 'green' {
  if (n === 0) return 'green';
  const reds = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
  return reds.includes(n) ? 'red' : 'black';
}
