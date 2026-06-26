import { useCallback, useEffect, useRef, useState } from 'react';
import { Simulation } from '../sim/sim';
import { defaultConfig } from '../sim/config';
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
  }, []);

  const sync = useCallback(() => setState(simRef.current.getState()), []);

  const reset = useCallback(
    (newSeed?: number) => {
      const s = newSeed ?? seed;
      simRef.current.cfg.seed = s;
      setSeed(s);
      simRef.current.reset();
      sync();
    },
    [seed, sync]
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
  };
}
