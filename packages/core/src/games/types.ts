/**
 * 游戏模块接口
 *
 * 每个游戏就是一组纯计算函数：开局 → 动作 → 结算。
 * 随机数从外面喂进来（不是内部随便调 Math.random），所以
 * 「同一组种子 + 同一串动作 = 永远同一个结果」——回放和审计全靠这个。
 *
 * 写新游戏时最容易犯的错：publicView 里把暗牌 / 崩溃点 / 未揭示的种子漏出去。
 * 一旦漏了，AI 就能直接看穿答案，「围观 AI 怎么玩」这件事就失去意义了。
 */

import { PlaygroundError } from '@ai-gaming/shared';
import type { GameMeta } from '@ai-gaming/shared';
import type { Rng } from '../rng';

export interface GameAction {
  type: string;
  [key: string]: unknown;
}

export interface GameEventDraft {
  type: string;
  payload?: Record<string, unknown>;
  /** 相对上一帧的毫秒延迟。前端按这个在虚拟时钟上播放动画。 */
  delayMs?: number;
}

export interface GameStep<S> {
  state: S;
  events: GameEventDraft[];
  done: boolean;
  /**
   * 需要追加的注额（黑杰克加倍、分牌这类）。
   * 引擎会额外扣这笔钱、记一条流水，并把它计入本局总投入。
   */
  stakeDeltaCents?: number;
}

export interface InitContext {
  betCents: number;
  rng: Rng;
  params: Record<string, unknown>;
}

/**
 * 时间轴上的一步。
 *
 * 只有 `pacing: 'realtime'` 的游戏需要它。普通游戏是「玩家动作 → 出结果」，
 * 但大火箭这类游戏里**时间本身会推进局面**：乘数一直在涨，崩溃点一到就炸，
 * 跟玩家动没动手无关。
 *
 * 游戏在这里声明「时间到了会发生什么」，引擎负责挂定时器按时执行 ——
 * 到点就当作庄家替玩家走一步 action，走完照常结算。
 * 如果玩家先收手（那一局已经结算），定时器到点会发现局已结束并跳过。
 *
 * `atMs` 是相对开局的毫秒数。
 */
export interface TimelineStep {
  atMs: number;
  action: GameAction;
  /** 这一步算谁做的，默认「庄家」 */
  actor?: string;
  reasoning?: string;
}

export interface SettleResult {
  /** 返还给玩家的总额（含本金）。全输就是 0。 */
  payoutCents: number;
  /** 本局总共投入多少注额（含中途追加的部分），用于算净额 */
  stakedCents: number;
  breakdown: Record<string, unknown>;
}

export interface GameModule<S = unknown> {
  meta: GameMeta;
  /** 开局。必须只依赖注入的 rng。 */
  init(ctx: InitContext): GameStep<S>;
  /** 校验动作合法性，不合法就抛 PlaygroundError */
  validate(state: S, action: GameAction): void;
  /** 推进一帧。纯函数。 */
  act(state: S, action: GameAction, rng: Rng): GameStep<S>;
  /** 该玩家此刻能看到什么。绝不泄露隐藏信息。 */
  publicView(state: S): Record<string, unknown>;
  /**
   * 结算。总注额由游戏自己记在 state 里——因为可能中途加倍，
   * 引擎不知道最终押了多少。
   */
  settle(state: S): SettleResult;
  /**
   * 时间轴。**只有 realtime 游戏需要实现**，其余游戏不实现即可。
   * 引擎在开局后按它挂定时器；返回空数组表示「这局只等玩家动作」。
   */
  timeline?(state: S): TimelineStep[];
}

export class GameRegistry {
  private readonly games = new Map<string, GameModule<any>>();

  register<S>(game: GameModule<S>): void {
    this.games.set(game.meta.id, game as GameModule<any>);
  }

  get(id: string): GameModule<any> | undefined {
    return this.games.get(id);
  }

  require(id: string): GameModule<any> {
    const g = this.games.get(id);
    if (!g) throw new PlaygroundError('GAME_NOT_FOUND', `没有这个游戏: ${id}`, 404);
    return g;
  }

  list(): GameModule<any>[] {
    return [...this.games.values()];
  }

  get size(): number {
    return this.games.size;
  }
}

/** 动作名不在 meta.actions 里就直接拒掉，避免 AI 提交乱七八糟的东西 */
export function assertKnownAction(meta: GameMeta, action: GameAction): void {
  if (!action || typeof action.type !== 'string') {
    throw new PlaygroundError('INVALID_ACTION', '动作必须是 { type: string } 形状');
  }
  if (!meta.actions.includes(action.type)) {
    throw new PlaygroundError(
      'INVALID_ACTION',
      `游戏 ${meta.id} 不接受动作 "${action.type}"，合法动作: ${meta.actions.join(', ')}`,
    );
  }
}
