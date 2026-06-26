import { useCallback, useEffect, useRef, useState } from 'react';
import { Simulation } from '../sim/sim';
import { defaultConfig } from '../sim/config';
import { useLivePrice } from './useLivePrice';
import type { SimState } from '../sim/types';

// Drives the deterministic tick loop in REAL TIME and surfaces the latest
// snapshot to React. 1 tick = 1 market-second, so at 1x one real second
// advances one market-second; `speed` multiplies that (2x, 5x, ...).
export function useSimulation() {
  const simRef = useRef<Simulation>(new Simulation({ ...defaultConfig }));
  const [state, setState] = useState<SimState>(() => simRef.current.getState());
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [seed, setSeed] = useState(defaultConfig.seed);

  const runningRef = useRef(running);
  const speedRef = useRef(speed);
  runningRef.current = running;
  speedRef.current = speed;

  // Live BTC price (external-price mode). Synthetic GBM is off by default now;
  // the live feed is the single price source of truth.
  const external = !!defaultConfig.externalPrice;
  const { priceRef, source } = useLivePrice(external);
  const seededRef = useRef(false);

  useEffect(() => {
    // Wall-clock paced: accumulate elapsed real time × speed and step one tick
    // per 1000ms of market time. Driving off elapsed time (not a fixed count)
    // keeps it accurate even if timers are throttled in a background tab.
    const MS_PER_TICK = 1000; // 1 tick = 1 market-second
    let last = performance.now();
    let acc = 0;
    const id = setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (!runningRef.current) return;

      if (external) {
        const p = priceRef.current;
        if (p == null) return; // wait for the live feed before running
        if (!seededRef.current) {
          // seed markets at the first live price, then start
          simRef.current.cfg.btcStart = p;
          simRef.current.reset();
          seededRef.current = true;
          setState(simRef.current.getState());
          return;
        }
        simRef.current.feedPrice(p);
      }

      acc += dt * speedRef.current;
      let stepped = 0;
      while (acc >= MS_PER_TICK && stepped < 5000) {
        simRef.current.step();
        acc -= MS_PER_TICK;
        stepped++;
      }
      if (stepped > 0) setState(simRef.current.getState());
    }, 100);
    return () => clearInterval(id);
  }, [external, priceRef]);

  const sync = useCallback(() => setState(simRef.current.getState()), []);

  const reset = useCallback(
    (newSeed?: number) => {
      const s = newSeed ?? seed;
      simRef.current.cfg.seed = s;
      setSeed(s);
      // in live mode, re-seed markets at the current live price on next tick
      if (external) seededRef.current = false;
      simRef.current.reset();
      sync();
    },
    [seed, sync, external]
  );

  return {
    sim: simRef.current,
    state,
    running,
    setRunning,
    speed,
    setSpeed,
    seed,
    setSeed,
    reset,
    sync,
    priceSource: external ? source : null,
  };
}
