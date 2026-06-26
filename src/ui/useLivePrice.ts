import { useEffect, useRef, useState } from 'react';

// Single price source of truth: the backend feed (same spot price Page 4 shows).
// The backend pulls it from Binance; the browser never opens its own Binance
// connection and there is NO synthetic fallback — if the backend is down, the
// sim simply waits.
const BACKEND = (import.meta.env.VITE_BACKEND_URL as string) || 'http://localhost:8787';

export function useLivePrice(active: boolean) {
  const priceRef = useRef<number | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [source, setSource] = useState<'connecting' | 'live' | 'offline'>('connecting');

  useEffect(() => {
    if (!active) return;
    let stopped = false;

    const poll = async () => {
      try {
        const r = await fetch(`${BACKEND}/api/price`);
        if (!r.ok) throw new Error('bad status');
        const d = await r.json();
        if (d.price > 0 && !stopped) {
          priceRef.current = d.price;
          setPrice(d.price);
          setSource('live');
        }
      } catch {
        if (!stopped) setSource('offline');
      }
    };

    poll();
    const id = setInterval(poll, 1000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [active]);

  return { price, priceRef, source };
}
