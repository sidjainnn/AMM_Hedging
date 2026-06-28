import { useState } from 'react';
import { useSimulation } from './ui/useSimulation';
import { Page1Trading } from './ui/Page1Trading';
import { Page2Hedge } from './ui/Page2Hedge';
import { Page3Backtest } from './ui/Page3Backtest';
import { Page4Live } from './ui/Page4Live';
import { Page5Market } from './ui/Page5Market';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { fmt } from './ui/format';

export default function App() {
  const { sim, state, running, setRunning, speed, setSpeed, seed, setSeed, reset, sync, priceSource } =
    useSimulation();
  const [page, setPage] = useState<1 | 2 | 3 | 4 | 5>(5);

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <h1>Crypto Binary Prediction Market — Research Simulator</h1>
          <span className="sub">live Binance feed · LMSR / CPMM / LS-LMSR inventory-priced AMM · real-time perp hedging · demo / paper</span>
        </div>

        <div className="tabs">
          <button className={'tab ' + (page === 5 ? 'active' : '')} onClick={() => setPage(5)}>
            5m Market
          </button>
          <button className={'tab ' + (page === 1 ? 'active' : '')} onClick={() => setPage(1)}>
            Trading
          </button>
          <button className={'tab ' + (page === 2 ? 'active' : '')} onClick={() => setPage(2)}>
            Hedge Overview
          </button>
          <button className={'tab ' + (page === 3 ? 'active' : '')} onClick={() => setPage(3)}>
            Backtest
          </button>
          <button className={'tab ' + (page === 4 ? 'active' : '')} onClick={() => setPage(4)}>
            Live (demo)
          </button>
        </div>

        <div className="spacer" />

        <div className="controls">
          <div className="pill">tick <b>{state.tick}</b></div>
          <div className="pill">BTC <b>${fmt(state.btc, 0)}</b></div>
          {priceSource && (
            <span className={'tag ' + (priceSource === 'live' ? 'deploy' : 'sim')}>
              {priceSource === 'live' ? 'live · binance' : priceSource === 'connecting' ? 'connecting…' : 'feed offline'}
            </span>
          )}
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
      {page === 4 && <Page4Live />}
      {page === 5 && <ErrorBoundary><Page5Market sim={sim} state={state} refresh={sync} /></ErrorBoundary>}
    </div>
  );
}
