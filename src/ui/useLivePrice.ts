import { useEffect, useRef, useState } from 'react';

const BACKEND = (import.meta.env.VITE_BACKEND_URL as string) || 'http://localhost:8787';
const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@trade';

export function useLivePrice(active: boolean) {
  const priceRef = useRef<number | null>(null);
  const gotDirectRef = useRef(false);

  const [price, setPrice] = useState<number | null>(null);
  const [source, setSource] = useState<'connecting' | 'binance' | 'backend' | 'offline'>('connecting');

  useEffect(() => {
    if (!active) return;

    let ws: WebSocket | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const connect = () => {
      ws = new WebSocket(BINANCE_WS);

      ws.onopen = () => {
        gotDirectRef.current = true;
        setSource('binance');
      };

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          const p = parseFloat(data.p);

          if (!isNaN(p)) {
            priceRef.current = p;
            setPrice(p);
            setSource('binance');
          }
        } catch {}
      };

      ws.onclose = () => {
        if (!disposed) setTimeout(connect, 1000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    const startFallback = () => {
      if (poll || disposed) return;

      poll = setInterval(async () => {
        if (gotDirectRef.current) return;

        try {
          const r = await fetch(`${BACKEND}/api/price`);
          const d = await r.json();

          if (d.price > 0) {
            priceRef.current = d.price;
            setPrice(d.price);
            setSource('backend');
          }
        } catch {
          setSource('offline');
        }
      }, 1000);
    };

    connect();

    const t = setTimeout(() => {
      if (!gotDirectRef.current) startFallback();
    }, 5000);

    return () => {
      disposed = true;
      ws?.close();
      if (poll) clearInterval(poll);
      clearTimeout(t);
    };
  }, [active]);

  return { price, priceRef, source };
}