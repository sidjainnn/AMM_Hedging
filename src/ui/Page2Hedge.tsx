import { useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import type { Simulation } from '../sim/sim';
import type { SimState, HedgeBookState } from '../sim/types';
import { digitalProb } from '../sim/events';
import { Slider } from './widgets';
import { fmt, usd, usd2, cls, ticksToClock } from './format';

const SHOCKS = [-0.05, -0.03, -0.01, 0.01, 0.03, 0.05];

export function Page2Hedge({
  sim,
  state,
  refresh,
}: {
  sim: Simulation;
  state: SimState;
  refresh: () => void;
}) {
  const [chartMode, setChartMode] = useState<'net' | 'components'>('net');
  const books = state.books;

  // per-tenor net-delta contribution (true σ) + flatten status
  const trueSigma = sim.cfg.btcVolPerTick;
  const kFlat = sim.cfg.kFlat;
  const tenorRows = sim.cfg.tenors.map((t) => {
    const ms = state.markets.filter((m) => m.tenorLabel === t.label);
    let delta = 0;
    let minTau = Infinity;
    let tracked = 0;
    for (const m of ms) {
      const tau = m.tauTicks;
      minTau = Math.min(minTau, tau);
      if (tau <= 0) continue;
      const { dpdS } = digitalProb(state.btc, m.strike, trueSigma, tau);
      const isFlat = trueSigma * Math.sqrt(tau) <= kFlat;
      if (!isFlat) {
        delta += m.netSkew * dpdS;
        tracked++;
      }
    }
    return { label: t.label, delta, minTau, tracked, count: ms.length };
  });

  const stress = sim.stress(SHOCKS);

  const pnlData = state.pnlSeries.map((p) => ({
    t: p.tick,
    btc: p.btc,
    A: p.A,
    B: p.B,
    C: p.C,
    spread: p.spreadCapture,
    inventory: p.inventoryPnl,
    hedge: p.hedgePnl,
    funding: p.funding,
  }));

  const nextRoll = Math.min(...state.markets.map((m) => m.tauTicks), Infinity);

  return (
    <div className="col">
      {/* exposure / risk strip */}
      <div className="panel">
        <h3>Exposure & risk <span className="hint">aggregate delta is the single number the hedge targets</span></h3>
        <div className="strip">
          <div className="cell">
            <div className="lbl">aggregate net δ</div>
            <div className="val">{fmt(state.aggregateDelta, 4)}</div>
            <div className="hint">BTC units (true σ)</div>
          </div>
          <div className="cell">
            <div className="lbl">τ* flatten threshold</div>
            <div className="val">{ticksToClock(state.tauStar)}</div>
            <div className="hint">σ√τ ≤ {fmt(kFlat, 3)}</div>
          </div>
          <div className="cell">
            <div className="lbl">time to next roll</div>
            <div className="val">{ticksToClock(nextRoll)}</div>
            <div className="hint">staggered tenors</div>
          </div>
          <div className="cell">
            <div className="lbl">est σ (deployable)</div>
            <div className="val">{fmt(state.estSigma * 100, 3)}%</div>
            <div className="hint">EWMA realised /tick</div>
          </div>
          <div className="cell">
            <div className="lbl">sim tick</div>
            <div className="val">{state.tick}</div>
            <div className="hint">BTC ${fmt(state.btc, 0)}</div>
          </div>
        </div>
      </div>

      {/* three book cards */}
      <div className="cards3">
        {books.map((b) => (
          <BookCard key={b.id} b={b} />
        ))}
      </div>

      {/* P&L over time */}
      <div className="panel">
        <h3>
          P&L over time
          <span className="hint"> · {chartMode === 'net' ? 'three books vs BTC' : 'Book A decomposition'}</span>
          <span style={{ float: 'right' }}>
            <span className="seg">
              <button className={chartMode === 'net' ? 'on' : ''} onClick={() => setChartMode('net')}>net</button>
              <button className={chartMode === 'components' ? 'on' : ''} onClick={() => setChartMode('components')}>components</button>
            </span>
          </span>
        </h3>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={pnlData} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
            <XAxis dataKey="t" tick={{ fill: '#8a93a6', fontSize: 10 }} stroke="#232a3b" />
            <YAxis yAxisId="pnl" tick={{ fill: '#8a93a6', fontSize: 10 }} stroke="#232a3b"
              width={60} tickFormatter={(v) => usd(v)} />
            <YAxis yAxisId="btc" orientation="right" domain={['auto', 'auto']}
              tick={{ fill: '#6b6b40', fontSize: 10 }} stroke="#232a3b" width={48}
              tickFormatter={(v) => (v / 1000).toFixed(0) + 'k'} />
            <Tooltip contentStyle={{ background: '#131722', border: '1px solid #232a3b', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#8a93a6' }} formatter={(v, n) => [n === 'btc' ? '$' + fmt(Number(v), 0) : usd2(Number(v)), n]} />
            <ReferenceLine yAxisId="pnl" y={0} stroke="#3a4357" />
            <Line yAxisId="btc" type="monotone" dataKey="btc" stroke="var(--sim)" dot={false} strokeWidth={1} opacity={0.5} isAnimationActive={false} />
            {chartMode === 'net' ? (
              <>
                <Line yAxisId="pnl" type="monotone" dataKey="A" stroke="var(--bookA)" dot={false} strokeWidth={1.8} isAnimationActive={false} />
                <Line yAxisId="pnl" type="monotone" dataKey="B" stroke="var(--bookB)" dot={false} strokeWidth={1.8} isAnimationActive={false} />
                <Line yAxisId="pnl" type="monotone" dataKey="C" stroke="var(--bookC)" dot={false} strokeWidth={1.8} isAnimationActive={false} />
              </>
            ) : (
              <>
                <Line yAxisId="pnl" type="monotone" dataKey="spread" stroke="var(--green)" dot={false} strokeWidth={1.6} isAnimationActive={false} />
                <Line yAxisId="pnl" type="monotone" dataKey="inventory" stroke="var(--red)" dot={false} strokeWidth={1.6} isAnimationActive={false} />
                <Line yAxisId="pnl" type="monotone" dataKey="hedge" stroke="var(--accent)" dot={false} strokeWidth={1.6} isAnimationActive={false} />
                <Line yAxisId="pnl" type="monotone" dataKey="funding" stroke="var(--purple)" dot={false} strokeWidth={1.6} isAnimationActive={false} />
              </>
            )}
          </LineChart>
        </ResponsiveContainer>
        <div className="legend">
          {chartMode === 'net' ? (
            <>
              <span><i style={{ background: 'var(--bookA)' }} />A pure hedge</span>
              <span><i style={{ background: 'var(--bookB)' }} />B ride bias</span>
              <span><i style={{ background: 'var(--bookC)' }} />C approx δ</span>
              <span><i style={{ background: 'var(--sim)' }} />BTC (right)</span>
            </>
          ) : (
            <>
              <span><i style={{ background: 'var(--green)' }} />spread capture</span>
              <span><i style={{ background: 'var(--red)' }} />inventory P&L</span>
              <span><i style={{ background: 'var(--accent)' }} />hedge P&L</span>
              <span><i style={{ background: 'var(--purple)' }} />funding</span>
              <span><i style={{ background: 'var(--sim)' }} />BTC (right)</span>
            </>
          )}
        </div>
      </div>

      <div className="row">
        {/* per-tenor breakdown */}
        <div className="panel" style={{ flex: 1.2, minWidth: 320 }}>
          <h3>Per-tenor breakdown <span className="hint">staggered-tenor smoothing</span></h3>
          <table>
            <thead><tr><th>tenor</th><th>net δ contrib</th><th>min τ</th><th>tracked</th><th>status</th></tr></thead>
            <tbody>
              {tenorRows.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td className={cls(r.delta)}>{fmt(r.delta, 4)}</td>
                  <td className="mut">{ticksToClock(r.minTau)}</td>
                  <td className="mut">{r.tracked}/{r.count}</td>
                  <td className={r.tracked < r.count ? 'neg' : 'mut'}>
                    {r.tracked < r.count ? 'partly flattened' : 'tracked'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* stress strip */}
        <div className="panel" style={{ flex: 1, minWidth: 300 }}>
          <h3>Static stress <span className="hint">instant BTC shock → reprice</span></h3>
          <table>
            <thead><tr><th>shock</th><th>A</th><th>B</th><th>C</th></tr></thead>
            <tbody>
              {stress.map((s) => (
                <tr key={s.shockPct}>
                  <td className={s.shockPct >= 0 ? 'pos' : 'neg'}>{(s.shockPct * 100).toFixed(0)}%</td>
                  <td className={cls(s.A)}>{usd(s.A)}</td>
                  <td className={cls(s.B)}>{usd(s.B)}</td>
                  <td className={cls(s.C)}>{usd(s.C)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="row">
        {/* knobs */}
        <div className="panel" style={{ flex: 1, minWidth: 300 }}>
          <h3>Hedge knobs <span className="hint">deliberately few</span></h3>
          <Slider label="Book B hedge dial h" value={sim.cfg.hedgeDialB} min={0} max={1} step={0.05}
            fmtVal={(v) => fmt(v, 2)} onChange={(v) => { sim.setHedgeDialB(v); refresh(); }} />
          <Slider label="k_flat (σ√τ threshold)" value={sim.cfg.kFlat} min={0.005} max={0.06} step={0.005}
            fmtVal={(v) => fmt(v, 3)} onChange={(v) => { sim.setKFlat(v); refresh(); }} />
          <Slider label="hedge fee (bps)" value={sim.cfg.feeBps} min={0} max={10} step={0.5}
            fmtVal={(v) => fmt(v, 1)} onChange={(v) => { sim.setFeeBps(v); refresh(); }} />
          <Slider label="funding rate / 8h" value={sim.cfg.fundingRate8h} min={-0.03} max={0.03} step={0.005}
            fmtVal={(v) => fmt(v * 100, 1) + '%'} onChange={(v) => { sim.setFunding8h(v); refresh(); }} />
        </div>

        {/* hedge activity log */}
        <div className="panel" style={{ flex: 1.2, minWidth: 320 }}>
          <h3>Hedge activity <span className="hint">watch turnover</span></h3>
          <div className="tape">
            {state.hedgeLog.length === 0 && <div className="mut">no hedge trades yet</div>}
            {state.hedgeLog.slice(0, 16).map((h, i) => (
              <div className="line" key={i}>
                <span className={h.deltaUnits >= 0 ? 'pos' : 'neg'}>
                  Book {h.book} {h.deltaUnits >= 0 ? 'buy' : 'sell'} {fmt(Math.abs(h.deltaUnits), 4)} BTC
                </span>
                <span className="mut">@ ${fmt(h.markPrice, 0)} · fee {usd2(h.fee)} · t{h.tick}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function BookCard({ b }: { b: HedgeBookState }) {
  return (
    <div className={`bookcard ${b.id}`}>
      <h4>{b.label}</h4>
      <div className={'net ' + cls(b.netPnl)}>{usd2(b.netPnl)}</div>
      <div className="kv"><span>position</span><span>{fmt(b.positionUnits, 4)} BTC</span></div>
      <div className="kv"><span>avg entry</span><span>${fmt(b.avgEntry, 0)}</span></div>
      <div className="kv"><span>target δ</span><span>{fmt(b.targetUnits, 4)}</span></div>
      <div className="kv"><span>spread capture</span><span className="pos">{usd2(b.spreadCapture)}</span></div>
      <div className="kv"><span>inventory P&L</span><span className={cls(b.inventoryPnl)}>{usd2(b.inventoryPnl)}</span></div>
      <div className="kv"><span>hedge P&L</span><span className={cls(b.hedgePnl)}>{usd2(b.hedgePnl)}</span></div>
      <div className="kv"><span>fees</span><span className="neg">-{usd2(b.fees)}</span></div>
      <div className="kv"><span>funding</span><span className={cls(b.funding)}>{usd2(b.funding)}</span></div>
    </div>
  );
}
