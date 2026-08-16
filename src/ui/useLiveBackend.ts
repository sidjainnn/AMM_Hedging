import { useEffect, useRef, useState, useCallback } from 'react';
import type { SimState } from '../sim/types';

const BACKEND =
  (import.meta.env.VITE_BACKEND_URL as string) || 'http://localhost:8787';

const WS_URL = BACKEND.replace(/^http/, 'ws') + '/ws';
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === '1';

/**
 * LIVE STATE (UPDATED MODEL)
 * spotPrice → UI display (Binance spot)
 * futuresMarkPrice → hedging + PnL engine
 */
export interface LiveInfo {
  spotPrice: number;
  futuresMarkPrice: number;

  feedError: string | null;
  symbol: string;
  venue: string;
  dryRun: boolean;
  hasKeys: boolean;

  hedgeEnabled: boolean;
  hedgeMode: 'delta' | 'sentiment' | 'combined';
  livePosition: number;
  maxPositionBtc: number;
  maxNotionalUsdt: number;

  hedgeError: string | null;

  // real Binance demo futures account
  account: { walletBalance: number; unrealizedPnl: number; equity: number; available: number } | null;
  startEquity: number | null;
  accountPnl: number;
  equitySeries: { t: number; equity: number; btc: number }[];

  hedgeLog: {
    ts: number;
    targetUnits: number;
    positionUnits: number;
    note: string;
    order: { side: string; qty: number; dryRun: boolean } | null;
  }[];
}

export type LiveState = SimState & { live: LiveInfo };

export function useLiveBackend(active: boolean) {
  const [state, setState] = useState<LiveState | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // No backend exists in the static showcase build — don't open a WebSocket to
    // localhost or poll it. Page 4 renders its "run the backend locally"
    // instructions instead, which is the correct thing to show there anyway.
    if (!active || DEMO_MODE) {
      wsRef.current?.close();
      setConnected(false);
      return;
    }

    let poll: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const startPolling = () => {
      if (poll) return;

      poll = setInterval(async () => {
        try {
          const r = await fetch(`${BACKEND}/api/state`);
          if (!r.ok) return;

          const data = await r.json();

          setState(data);
          setConnected(true);
        } catch {
          setConnected(false);
        }
      }, 1000);
    };

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          setState(data);
        } catch {
          // ignore malformed updates
        }
      };

      ws.onclose = () => {
        if (!closed) {
          setConnected(false);
          startPolling();
        }
      };

      ws.onerror = () => {
        setConnected(false);
        startPolling();
      };
    } catch {
      startPolling();
    }

    return () => {
      closed = true;
      wsRef.current?.close();
      if (poll) clearInterval(poll);
    };
  }, [active]);

  const setHedge = useCallback(async (enabled: boolean) => {
    try {
      await fetch(`${BACKEND}/api/hedge/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    } catch {
      // ignore
    }
  }, []);

  const setMode = useCallback(async (mode: 'delta' | 'sentiment' | 'combined') => {
    try {
      await fetch(`${BACKEND}/api/hedge/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
    } catch {
      // ignore
    }
  }, []);

  return { state, connected, setHedge, setMode, backend: BACKEND };
}