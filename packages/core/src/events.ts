/**
 * 事件总线
 *
 * 所有对外可见的帧都从这里出去。WebSocket 只是它的一个订阅者——
 * 以后要加「把事件转发到某个 webhook」「录制成视频」之类，都只是再加一个订阅者。
 */

import type { ServerFrame } from '@ai-gaming/shared';

export type Subscriber = (frame: ServerFrame) => void;

export class EventBus {
  private readonly subs = new Set<Subscriber>();

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  publish(frame: ServerFrame): void {
    for (const fn of this.subs) {
      try {
        fn(frame);
      } catch {
        // 单个订阅者出错不能拖垮牌局
      }
    }
  }

  get subscriberCount(): number {
    return this.subs.size;
  }
}
