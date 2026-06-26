import { useEffect, useRef, useState } from 'react';

// Live BTC price for the browser sim. Tries Binance's public markPrice
// WebSocket directly (works in a normal browser); if that's blocked, falls back
// to the backend's relayed price (the backend can always reach Binance).
const BACKEND = (import.meta.env.VITE_BACKEND_URL as string) || 'http://localhost:8787';
const BINANCE_WS = 'wss://fstream.binance.com/ws/btcusdt@markPrice@1s';

export function useLivePrice(active: boolean) {
  const priceRef = useRef<number | null>(null);
  const [source, setSource] = useState<'connecting' | 'binance' | 'backend' | 'offline'>('connecting');

  useEffect(() => {
    if (!active) return;
    let ws: WebSocket | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let gotDirect = false;
    let disposed = false;

    const startFallback = () => {
      if (poll || disposed) return;
      poll = setInterval(async () => {
        if (gotDirect) return;
        try {
          const r = await fetch(`${BACKEND}/api/price`);
          if (r.ok) {
            const d = await r.json();
            if (d.price > 0) { priceRef.current = d.price; setSource('backend'); }
          }
        } catch {
          setSource('offline');
        }
      }, 1000);
    };

    try {
      ws = new WebSocket(BINANCE_WS);
      ws.onmessage = (e) => {
        gotDirect = true;
        const p = parseFloat(JSON.parse(e.data).p);
        if (p > 0) { priceRef.current = p; setSource('binance'); }
      };
      ws.onerror = startFallback;
      ws.onclose = startFallback;
    } catch {
      startFallback();
    }
    const t = setTimeout(() => { if (!gotDirect) startFallback(); }, 4000);

    return () => {
      disposed = true;
      ws?.close();
      if (poll) clearInterval(poll);
      clearTimeout(t);
    };
  }, [active]);

  return { priceRef, source };
}
