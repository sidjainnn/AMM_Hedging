import { useState } from 'react';
import { useSimulation } from './ui/useSimulation';
import { Page1Trading } from './ui/Page1Trading';
import { Page2Hedge } from './ui/Page2Hedge';
import { Page3Backtest } from './ui/Page3Backtest';
import { fmt } from './ui/format';

export default function App() {
  const { sim, state, running, setRunning, speed, setSpeed, seed, setSeed, reset, sync } =
    useSimulation();
  const [page, setPage] = useState<1 | 2 | 3>(1);

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <h1>Crypto Binary Prediction Market — Research Simulator</h1>
          <span className="sub">feed-free pricing · LMSR / CPMM / LS-LMSR · real-time hedging · all simulated, no real money</span>
        </div>

        <div className="tabs">
          <button className={'tab ' + (page === 1 ? 'active' : '')} onClick={() => setPage(1)}>
            Trading
          </button>
          <button className={'tab ' + (page === 2 ? 'active' : '')} onClick={() => setPage(2)}>
            Hedge Overview
          </button>
          <button className={'tab ' + (page === 3 ? 'active' : '')} onClick={() => setPage(3)}>
            Backtest
          </button>
        </div>

        <div className="spacer" />

        <div className="controls">
          <div className="pill">tick <b>{state.tick}</b></div>
          <div className="pill">BTC <b>${fmt(state.btc, 0)}</b></div>
          <button className={'btn ' + (running ? '' : 'primary')} onClick={() => setRunning((r) => !r)}>
            {running ? '⏸ Pause' : '▶ Play'}
          </button>
          {!running && (
            <button className="btn" onClick={() => { sim.step(); sync(); }}>Step</button>
          )}
          <div className="seg">
            {[1, 2, 5, 10, 30].map((s) => (
              <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>
                {s}×
              </button>
            ))}
          </div>
          <div className="pill">
            seed
            <input
              style={{ width: 64, background: 'var(--panel-2)', color: 'var(--text)',
                border: '1px solid var(--border)', borderRadius: 6, padding: '5px 7px', fontSize: 12 }}
              type="number"
              value={seed}
              onChange={(e) => setSeed(parseInt(e.target.value || '0', 10))}
            />
          </div>
          <button className="btn danger" onClick={() => reset()}>↺ Reset</button>
        </div>
      </div>

      {page === 1 && <Page1Trading sim={sim} state={state} refresh={sync} />}
      {page === 2 && <Page2Hedge sim={sim} state={state} refresh={sync} />}
      {page === 3 && <Page3Backtest />}
    </div>
  );
}
