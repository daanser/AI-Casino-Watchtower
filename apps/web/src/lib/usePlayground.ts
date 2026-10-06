/**
 * 观察台的连接层：一条 WebSocket + 一个 reducer。
 *
 * 状态怎么变全在 ./reducer.ts（纯函数，可单测）；
 * 这里只负责「连上、收帧、断线重连、拉快照」这些副作用。
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { BotStatus, ServerFrame, TableRuntime, WalletRow } from './types';
import { initialState, reducer, type State } from './reducer';

export interface PlaygroundController {
  state: State;
  tables: TableRuntime[];
  wallets: WalletRow[];
  bots: BotStatus[];
  walletName: (id: number | null) => string;
  clearFeed: () => void;
  reconnect: () => void;
}

export function usePlayground(): PlaygroundController {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [connEpoch, setConnEpoch] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);

  const loadSnapshot = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/state');
      if (!res.ok) return;
      dispatch({ type: 'snapshot', snapshot: await res.json() });
    } catch {
      /* 快照拉不到不影响实时帧，静默重试即可 */
    }
  }, []);

  /**
   * 连接与重连都收在 effect 里，用局部 disposed 标志判断生命周期。
   *
   * 为什么不用 useCallback 包一个 connect()？因为 React 严格模式会
   * mount → cleanup → mount，而 WebSocket 的 onclose 是异步派发的，
   * 用 ref 存「是否主动关闭」会在时序上串味，凭空多出一次重连。
   * 局部标志 + effect 重跑（connEpoch）能干净地避开这个问题。
   */
  useEffect(() => {
    let disposed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let uidSeq = 0;

    const open = () => {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      socketRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        retry = 0;
        dispatch({ type: 'ws_open' });
      };

      ws.onmessage = (ev) => {
        if (disposed) return;
        try {
          const frame = JSON.parse(String(ev.data)) as ServerFrame;
          uidSeq += 1;
          dispatch({
            type: 'frame',
            frame: { ...frame, _uid: `f${uidSeq}`, _at: Date.now() },
          });
        } catch {
          /* 解析不了的帧直接丢 */
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        dispatch({ type: 'ws_close' });
        retry = Math.min(retry + 1, 8);
        timer = setTimeout(open, Math.min(300 * 2 ** (retry - 1), 5000));
      };

      ws.onerror = () => {
        /* onclose 会接手 */
      };
    };

    void loadSnapshot();
    open();

    // 快照每 15 秒兜底刷新一次，防止长时间只靠增量导致漂移
    const poll = setInterval(() => void loadSnapshot(), 15_000);

    return () => {
      disposed = true;
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [loadSnapshot, connEpoch]);

  const reconnect = useCallback(() => setConnEpoch((e) => e + 1), []);

  const walletName = useCallback(
    (id: number | null) => {
      if (id === null) return '—';
      return state.wallets[id]?.display_name ?? `钱包 #${id}`;
    },
    [state.wallets],
  );

  const tables = useMemo(() => {
    const botOrder = new Map((state.snapshot?.bots ?? []).map((b, i) => [b.tableId, i]));
    return Object.values(state.tables).sort((a, b) => {
      // Bot 按 runner 的固定序号钉在网格前排；游戏状态变化不影响顺序。
      const ai = botOrder.get(a.tableId) ?? Number.MAX_SAFE_INTEGER;
      const bi = botOrder.get(b.tableId) ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.tableId.localeCompare(b.tableId);
    });
  }, [state.tables, state.snapshot?.bots]);

  const wallets = useMemo(
    () => Object.values(state.wallets).sort((a, b) => b.balance_cents - a.balance_cents),
    [state.wallets],
  );

  const clearFeed = useCallback(() => dispatch({ type: 'clear_feed' }), []);

  return {
    state,
    tables,
    wallets,
    bots: state.snapshot?.bots ?? [],
    walletName,
    clearFeed,
    reconnect,
  };
}
