import { useCallback, useEffect, useRef, useState } from 'react';
import { Simulation } from '../sim/sim';
import { defaultConfig } from '../sim/config';
import type { SimState } from '../sim/types';

// Drives the deterministic tick loop and surfaces the latest snapshot to React.
// `speed` = sim ticks executed per animation frame batch.
export function useSimulation() {
  const simRef = useRef<Simulation>(new Simulation({ ...defaultConfig }));
  const [state, setState] = useState<SimState>(() => simRef.current.getState());
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(2);
  const [seed, setSeed] = useState(defaultConfig.seed);

  const runningRef = useRef(running);
  const speedRef = useRef(speed);
  runningRef.current = running;
  speedRef.current = speed;

  useEffect(() => {
    // setInterval (not rAF) so the loop keeps advancing even when the tab is
    // backgrounded; advance `speed` ticks per interval for a lively feed.
    const id = setInterval(() => {
      if (!runningRef.current) return;
      const sim = simRef.current;
      for (let i = 0; i < speedRef.current; i++) sim.step();
      setState(sim.getState());
    }, 90);
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
