import { useCallback, useEffect, useState } from 'react';

// Lightweight control for the Binance (demo) hedge from the 5m page: polls the
// backend hedge status and toggles it on/off. Does NOT pull the full sim state.
const BACKEND = (import.meta.env.VITE_BACKEND_URL as string) || 'http://localhost:8787';

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
}

export function useHedgeControl() {
  const [status, setStatus] = useState<HedgeStatus | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
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

  return { status, connected, setEnabled };
}
