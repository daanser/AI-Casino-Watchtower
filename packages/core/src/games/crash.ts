/**
 * 大火箭（Crash）
 *
 * 乘数从 1.00 起持续上涨，玩家随时可以收手落袋；涨到「崩溃点」还没收手就全输。
 *
 * 崩溃点分布：P(崩溃点 ≥ m) = 0.97 / m，所以**不管你什么时候收手，返还率恒为 97%**。
 * 也就是说这个游戏没有「正确策略」——它纯粹赌你能不能克制住贪心。
 *
 * 实时性怎么保证确定性：
 *   玩家的动作携带 atMs（起飞后第几毫秒收手），时间戳是动作的一部分，
 *   所以「种子 + 动作序列」依然能完整复现一局。回放时不需要真的等 8 秒。
 */

import { PlaygroundError } from '@ai-gaming/shared';
import type { GameAction, GameEventDraft, GameModule, GameStep } from './types';
import { assertKnownAction } from './types';

/** 乘数涨到 2 倍需要的毫秒数。前端动画必须用同一个常数。 */
export const GROWTH_HALF_LIFE_MS = 5000;

/** 庄家优势 3%：P(崩溃点 ≥ m) = 0.97 / m */
const FAIR_FACTOR = 0.97;

/** 一次飞行最长算多久，防止 AI 提交一个荒谬的毫秒数 */
export const MAX_FLIGHT_MS = 90_000;

/** 毫秒 → 乘数（保留两位） */
export function multiplierAt(ms: number): number {
  const m = 2 ** (ms / GROWTH_HALF_LIFE_MS);
  return Math.round(m * 100) / 100;
}

/** 目标乘数 → 需要飞多久。Bot 用这个把「我想在 1.8 倍收手」翻译成毫秒。 */
export function msForMultiplier(target: number): number {
  return Math.round(GROWTH_HALF_LIFE_MS * Math.log2(Math.max(1, target)));
}

export interface CrashState {
  stakeCents: number;
  /** 崩溃点。开局定死，揭示前绝不外泄。 */
  crashPoint: number;
  cashoutAtMs: number | null;
  cashoutMultiplier: number | null;
  busted: boolean;
  revealed: boolean;
  step: number;
}

export const crash: GameModule<CrashState> = {
  meta: {
    id: 'crash',
    name: '大火箭',
    description:
      '乘数从 1.00 开始上涨，每 5 秒翻一倍（2 倍 / 4 倍 / 8 倍…）。你随时可以收手落袋，' +
      '但如果在乘数涨到崩溃点之前还没收手，就全输。崩溃点开局就已确定，无法预测。' +
      '动作：{"type":"cashout","atMs":起飞后第几毫秒收手}。理论返还率 97%，' +
      '换句话说什么时候收手都一样，唯一的变量是你的贪心。',
    minBetCents: 100,
    maxBetCents: 100000,
    actions: ['cashout'],
    pacing: 'realtime',
  },

  init({ rng, betCents }) {
    // 反变换采样：crashPoint = 0.97 / (1 - u)
    // u ≥ 0.97 时结果小于 1，视为「起飞即炸」
    const u = rng.float();
    const crashPoint = Math.max(1, Math.floor((FAIR_FACTOR / (1 - u)) * 100) / 100);

    return {
      state: {
        stakeCents: betCents,
        crashPoint,
        cashoutAtMs: null,
        cashoutMultiplier: null,
        busted: false,
        revealed: false,
        step: 0,
      },
      events: [
        {
          type: 'rocket_launch',
          payload: { growthHalfLifeMs: GROWTH_HALF_LIFE_MS },
          delayMs: 0,
        },
      ],
      done: false,
    };
  },

  validate(state, action: GameAction) {
    assertKnownAction(crash.meta, action);
    if (state.revealed) {
      throw new PlaygroundError('DUPLICATE_ACTION', '这一局已经结束了');
    }
    const atMs = Number(action.atMs);
    if (!Number.isFinite(atMs) || atMs < 0) {
      throw new PlaygroundError('INVALID_ACTION', 'cashout 必须带一个非负的 atMs（毫秒）');
    }
  },

  act(state, action): GameStep<CrashState> {
    const atMs = Math.max(0, Math.min(Number(action.atMs ?? 0), MAX_FLIGHT_MS));
    const reached = multiplierAt(atMs);
    const busted = reached >= state.crashPoint;
    const cashoutMultiplier = busted ? null : reached;

    const events: GameEventDraft[] = [
      {
        type: 'rocket_progress',
        payload: { atMs, multiplier: reached, growthHalfLifeMs: GROWTH_HALF_LIFE_MS },
        delayMs: atMs,
      },
    ];

    if (busted) {
      events.push({
        type: 'rocket_crash',
        payload: { crashPoint: state.crashPoint, atMs },
        delayMs: 400,
      });
    } else {
      events.push({
        type: 'cashout',
        payload: {
          multiplier: reached,
          payoutCents: Math.round(state.stakeCents * reached),
        },
        delayMs: 100,
      });
    }

    return {
      state: {
        ...state,
        cashoutAtMs: atMs,
        cashoutMultiplier,
        busted,
        revealed: true,
        step: state.step + 1,
      },
      events,
      done: true,
    };
  },

  /** 崩溃点在结算前一个字都不能漏 —— 漏了 AI 就能稳赢 */
  publicView(state) {
    if (!state.revealed) {
      return { revealed: false, growthHalfLifeMs: GROWTH_HALF_LIFE_MS };
    }
    return {
      revealed: true,
      crashPoint: state.crashPoint,
      cashoutAtMs: state.cashoutAtMs,
      multiplier: state.cashoutMultiplier,
      busted: state.busted,
    };
  },

  settle(state) {
    const multiplier = state.cashoutMultiplier ?? 0;
    return {
      payoutCents: Math.round(state.stakeCents * multiplier),
      stakedCents: state.stakeCents,
      breakdown: {
        crashPoint: state.crashPoint,
        cashoutAtMs: state.cashoutAtMs,
        multiplier,
        busted: state.busted,
        won: multiplier > 1,
      },
    };
  },

  /**
   * 崩溃点一到就炸 —— 这是大火箭唯一「时间推进局面」的地方。
   *
   * 到点由引擎替玩家走一次 cashout：此刻乘数刚好涨到崩溃点，必然 busted，
   * 于是服务端**自己**把爆炸广播出去。
   *
   * 在这之前这个缺口是：服务端只在玩家动作时才推事件，所以前端根本不知道
   * 什么时候该炸 —— 它只能一路飞下去，直到玩家收手才收到结算帧，
   * 画面于是从「飞在 3.57×」直接跳到「崩在 1.22×」。大火箭最值钱的那一下
   * （眼睁睁看着它炸）从来没被播出来过。
   */
  timeline(state) {
    if (state.revealed) return [];
    // +1ms：让 multiplierAt 稳稳越过崩溃点，不受四舍五入影响
    const atMs = msForMultiplier(state.crashPoint) + 1;
    // 崩溃点远到超出可飞行上限（约 2^18 倍）时不挂定时器 —— 概率 3.7e-6，
    // 真遇上了交给玩家自己收手，也好过挂一个 90 秒后才响的闹钟。
    if (atMs > MAX_FLIGHT_MS) return [];
    return [
      {
        atMs,
        action: { type: 'cashout', atMs },
        actor: '庄家',
        reasoning: `乘数涨到 ${state.crashPoint.toFixed(2)}×，火箭炸了。`,
      },
    ];
  },
};
