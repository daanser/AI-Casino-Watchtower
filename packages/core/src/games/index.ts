/**
 * 游戏注册表
 *
 * 14 款游戏：经典桌游 + 高低波动游戏。
 *   instant   一把结算
 *   realtime  实时推进
 *   turnbased 玩家连续决策
 */

import { GameRegistry } from './types';
import { roulette } from './roulette';
import { slots } from './slots';
import { dragonTiger } from './dragon-tiger';
import { crash } from './crash';
import { blackjack } from './blackjack';
import { baccarat } from './baccarat';
import { sicbo } from './sicbo';
import { holdem } from './holdem';
import { videoPoker } from './video-poker';
import { wheel } from './wheel';
import { plinko } from './plinko';
import { craps } from './craps';
import { keno } from './keno';
import { hiLo } from './hi-lo';

export function createRegistry(): GameRegistry {
  const registry = new GameRegistry();
  registry.register(roulette);
  registry.register(slots);
  registry.register(dragonTiger);
  registry.register(crash);
  registry.register(blackjack);
  registry.register(baccarat);
  registry.register(sicbo);
  registry.register(holdem);
  registry.register(videoPoker);
  registry.register(wheel);
  registry.register(plinko);
  registry.register(craps);
  registry.register(keno);
  registry.register(hiLo);
  return registry;
}

export * from './types';
export * from './poker';
export * from './roulette';
export * from './slots';
export * from './dragon-tiger';
export * from './crash';
export * from './blackjack';
export * from './baccarat';
export * from './sicbo';
export * from './holdem';
export * from './video-poker';
export * from './wheel';
export * from './plinko';
export * from './craps';
export * from './keno';
export * from './hi-lo';
