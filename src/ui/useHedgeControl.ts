import { useCallback, useEffect, useState } from 'react';

// Lightweight control for the Binance (demo) hedge from the 5m page: polls the
// backend hedge status and toggles it on/off. Does NOT pull the full sim state.
const BACKEND = (import.meta.env.VITE_BACKEND_URL as string) || 'http://localhost:8787';
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === '1';

export interface HedgeStatus {
  hedgeEnabled: boolean;
  dryRun: boolean;
  hasKeys: boolean;
  hedgeMode: 'delta' | 'sentiment' | 'combined';
  livePosition: number;
  equity: number | null;
  mark: number;
  symbol: string;
  hedgeError: string | null;
  realizedVol: number;
  volThreshold: number;
  volGate: boolean;
  notionalUsdt: number;
  notionalGate: number; // effective gate (adaptive percentile or fixed)
  gateMode: 'adaptive' | 'fixed';
  gatePctl: number;
  idleReason: 'armed' | 'idle-vol' | 'idle-inv' | 'disabled' | 'untracked';
  hedgeActive: boolean;
  feesPaid: number;
  leverage: number;
  abRunning: boolean;
  abPos: number;
  abBlocksOn: number;
  abBlocksOff: number;
}

export function useHedgeControl() {
  const [status, setStatus] = useState<HedgeStatus | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // The static showcase build has no backend to poll. Without this guard the
    // hosted demo fires a failed request at localhost:8787 every 2 seconds
    // forever, filling a visitor's console with ERR_CONNECTION_REFUSED.
    if (DEMO_MODE) return;

    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch(`${BACKEND}/api/hedge/status`);
        if (r.ok && !stop) { setStatus(await r.json()); setConnected(true); }
      } catch {
        if (!stop) setConnected(false);
      }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  const setGates = useCallback(async (patch: { notionalUsdt?: number; volThreshold?: number; mode?: 'adaptive' | 'fixed'; pctl?: number }) => {
    try {
      const r = await fetch(`${BACKEND}/api/hedge/gates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (r.ok) setStatus(await r.json());
    } catch { /* ignore */ }
  }, []);

  const setLeverage = useCallback(async (leverage: number) => {
    try {
      const r = await fetch(`${BACKEND}/api/hedge/leverage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leverage }),
      });
      if (r.ok) setStatus((s) => (s ? { ...s, leverage } : s));
    } catch { /* ignore */ }
  }, []);

  const setAB = useCallback(async (running: boolean) => {
    try {
      const r = await fetch(`${BACKEND}/api/ab`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ running }),
      });
      if (r.ok) setStatus(await r.json());
    } catch { /* ignore */ }
  }, []);

  const setEnabled = useCallback(async (on: boolean) => {
    try {
      const r = await fetch(`${BACKEND}/api/hedge/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: on }),
      });
      if (r.ok) setStatus((s) => (s ? { ...s, hedgeEnabled: on } : s));
    } catch { /* ignore */ }
  }, []);

  return { status, connected, setEnabled, setGates, setLeverage, setAB };
}
