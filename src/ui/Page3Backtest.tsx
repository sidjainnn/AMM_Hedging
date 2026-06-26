import { useState, useEffect } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { runBacktest, type BacktestResult } from '../sim/backtest';
import { usd, usd2, cls, fmt } from './format';

const COLORS: Record<string, string> = {
  LMSR: 'var(--bookA)',
  CPMM: 'var(--bookC)',
  'LS-LMSR': 'var(--green)',
};

// equal-spread comparison uses a fixed symmetric half-spread (no Stoikov skew)
const MANUAL_HALF = 0.04;

export function Page3Backtest() {
  const [ticks, setTicks] = useState(2000);
  const [nSeeds, setNSeeds] = useState(4);
  // seedBase changes on "New seeds" so a re-run resamples (results are
  // deterministic per seed set, so re-running the SAME seeds is identical).
  const [seedBase, setSeedBase] = useState(1);
  const [running, setRunning] = useState(false);
  const [data, setData] = useState<{ stoikov: BacktestResult; manual: BacktestResult } | null>(null);

  // The backtest is a heavy synchronous compute. Flip on "Running…" first, then
  // yield (setTimeout) so React paints the loading state before the main thread
  // blocks — otherwise the click looks frozen / dead.
  useEffect(() => {
    setRunning(true);
    const id = setTimeout(() => {
      const seeds = Array.from(
        { length: nSeeds },
        (_, i) => ((seedBase * 7919 + i * 1013904223) >>> 0) || 1
      );
      const stoikov = runBacktest({ mode: 'stoikov', seeds, ticks, samples: 120 });
      const manual = runBacktest({ mode: 'manual', manualHalfSpread: MANUAL_HALF, seeds, ticks, samples: 120 });
      setData({ stoikov, manual });
      setRunning(false);
    }, 40);
    return () => clearTimeout(id);
  }, [ticks, nSeeds, seedBase]);

  return (
    <div className="col">
      <div className="panel">
        <h3>
          Engine backtest <span className="hint">avg Book-A net P&L over {nSeeds} seeds · {ticks} ticks · which engine profits most / loses least</span>
        </h3>
        <div className="row" style={{ alignItems: 'center', gap: 24 }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label className="hint">backtest length: {ticks} ticks ({fmt(ticks / 60, 0)} min)</label>
            <input type="range" min={1000} max={8000} step={500} value={ticks} disabled={running}
              onChange={(e) => setTicks(parseInt(e.target.value))} />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label className="hint">seeds averaged: {nSeeds}</label>
            <input type="range" min={1} max={12} step={1} value={nSeeds} disabled={running}
              onChange={(e) => setNSeeds(parseInt(e.target.value))} />
          </div>
          <button className="btn primary" disabled={running}
            onClick={() => setSeedBase(Math.floor(Math.random() * 1e6) + 1)}>
            {running ? '⏳ Running…' : '↻ New seeds'}
          </button>
        </div>
      </div>

      {!data ? (
        <div className="panel" style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>
          Running backtest…
        </div>
      ) : (
        <div className="row" style={{ opacity: running ? 0.5 : 1 }}>
          <Chart
            title="With Avellaneda–Stoikov quoting"
            hint="inventory-aware, asymmetric spread"
            data={data.stoikov}
          />
          <Chart
            title="Without Stoikov — equal fixed spread"
            hint={`symmetric ±${(MANUAL_HALF * 100).toFixed(0)}¢, same on both sides`}
            data={data.manual}
          />
        </div>
      )}
    </div>
  );
}

function Chart({ title, hint, data }: { title: string; hint: string; data: BacktestResult }) {
  return (
    <div className="panel" style={{ flex: 1, minWidth: 420 }}>
      <h3>{title} <span className="hint">· {hint}</span></h3>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data.curve} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
          <XAxis dataKey="tick" tick={{ fill: '#8a93a6', fontSize: 10 }} stroke="#232a3b" />
          <YAxis tick={{ fill: '#8a93a6', fontSize: 10 }} stroke="#232a3b" width={58}
            tickFormatter={(v) => usd(v)} />
          <Tooltip contentStyle={{ background: '#131722', border: '1px solid #232a3b', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: '#8a93a6' }} formatter={(v, n) => [usd2(Number(v)), n]} />
          <ReferenceLine y={0} stroke="#3a4357" />
          <Line type="monotone" dataKey="LMSR" stroke={COLORS.LMSR} dot={false} strokeWidth={1.8} isAnimationActive={false} />
          <Line type="monotone" dataKey="CPMM" stroke={COLORS.CPMM} dot={false} strokeWidth={1.8} isAnimationActive={false} />
          <Line type="monotone" dataKey="LS-LMSR" stroke={COLORS['LS-LMSR']} dot={false} strokeWidth={1.8} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <div className="legend">
        <span><i style={{ background: COLORS.LMSR }} />LMSR</span>
        <span><i style={{ background: COLORS.CPMM }} />CPMM</span>
        <span><i style={{ background: COLORS['LS-LMSR'] }} />LS-LMSR</span>
      </div>
      <table style={{ marginTop: 8 }}>
        <thead><tr><th>engine</th><th>mean net</th><th>worst</th><th>best</th><th>profit</th></tr></thead>
        <tbody>
          {data.summary.map((s) => (
            <tr key={s.engine}>
              <td><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: COLORS[s.engine], marginRight: 6 }} />{s.engine}</td>
              <td className={cls(s.mean)}>{usd(s.mean)}</td>
              <td className={cls(s.worst)}>{usd(s.worst)}</td>
              <td className={cls(s.best)}>{usd(s.best)}</td>
              <td className="mut">{s.profit}/{s.seeds}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
