import { useCallback, useEffect, useRef, useState } from 'react';
import { Simulation } from '../sim/sim';
import { defaultConfig } from '../sim/config';
import { useLivePrice } from './useLivePrice';
import type { SimState } from '../sim/types';

// Static-showcase build flag (set by the GitHub Pages workflow). Off in normal
// dev/prod builds, where the live Binance feed is the source of truth.
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === '1';

// Drives the deterministic tick loop in REAL TIME and surfaces the latest
// snapshot to React. 1 tick = 1 market-second, so at 1x one real second
// advances one market-second; `speed` multiplies that (2x, 5x, ...).
export function useSimulation() {
  // One Simulation instance for the lifetime of the hook. Held in state (with a
  // lazy initialiser) rather than a ref: the identity never changes, so this is
  // a value the render output may legitimately depend on, and reading it during
  // render is safe in a way that reading a ref is not.
  const [sim] = useState(() => new Simulation({ ...defaultConfig }));
  const [state, setState] = useState<SimState>(() => sim.getState());
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [seed, setSeed] = useState(defaultConfig.seed);

  // The tick loop below runs inside a single long-lived setInterval, so it can't
  // close over `running`/`speed` directly — it would capture the values from the
  // render that created it. Mirroring them into refs lets the loop read the
  // current values without resubscribing (which would reset tick timing).
  //
  // The mirroring happens in an effect, not during render: a render can be
  // discarded (StrictMode's double-render, concurrent rendering, the React
  // Compiler), and writing a ref from one that never commits would leave the
  // loop reading a value the UI never actually showed.
  const runningRef = useRef(running);
  const speedRef = useRef(speed);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  // Live BTC price (external-price mode). Synthetic GBM is off by default now;
  // the live feed is the single price source of truth.
  //
  // EXCEPT in the static demo build (VITE_DEMO_MODE=1, used for the GitHub Pages
  // deployment): there is no backend to serve the Binance feed, so the sim falls
  // back to its own seeded GBM — the same synthetic process the headless
  // backtest/validate tools use. The UI labels this clearly (see App.tsx); it is
  // a showcase build, NOT the configuration any research result was taken from.
  const external = DEMO_MODE ? false : !!defaultConfig.externalPrice;
  const { priceRef, source, sourceRef } = useLivePrice(external);
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
        // stale-feed guard: freeze market time while the feed is down/stale so
        // markets can't settle on a frozen price; drop accumulated time so
        // recovery doesn't fast-forward through the outage.
        if (sourceRef.current !== 'live') {
          acc = 0;
          return;
        }
        if (!seededRef.current) {
          // seed markets at the first live price, then start
          sim.setBtcStart(p);
          sim.reset();
          seededRef.current = true;
          setState(sim.getState());
          return;
        }
        sim.feedPrice(p);
      }

      acc += dt * speedRef.current;
      let stepped = 0;
      while (acc >= MS_PER_TICK && stepped < 5000) {
        sim.step();
        acc -= MS_PER_TICK;
        stepped++;
      }
      if (stepped > 0) setState(sim.getState());
    }, 100);
    return () => clearInterval(id);
  }, [external, priceRef, sourceRef, sim]);

  const sync = useCallback(() => setState(sim.getState()), [sim]);

  const reset = useCallback(
    (newSeed?: number) => {
      const s = newSeed ?? seed;
      sim.setSeed(s);
      setSeed(s);
      // in live mode, re-seed markets at the current live price on next tick
      if (external) seededRef.current = false;
      sim.reset();
      sync();
    },
    [seed, sync, external, sim]
  );

  return {
    sim,
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
