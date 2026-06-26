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
import type { SimState, EngineKind, QuotingMode } from '../sim/types';
import type { AgentModel } from '../sim/agents';
import { Slider, Seg, Provenance } from './widgets';
import { fmt, ticksToClock, cls } from './format';

export function Page1Trading({
  sim,
  state,
  refresh,
}: {
  sim: Simulation;
  state: SimState;
  refresh: () => void;
}) {
  const [selId, setSelId] = useState<string | null>(null);
  const sel =
    state.markets.find((m) => m.id === selId) ?? state.markets[0] ?? null;

  const q = sim.cfg.quote;
  const btcData = state.btcSeries.map((p) => ({ t: p.tick, btc: p.btc }));

  // group markets by tenor for the rolling-tenor summary
  const tenors = sim.cfg.tenors.map((t) => {
    const ms = state.markets.filter((m) => m.tenorLabel === t.label);
    const nextClose = Math.min(...ms.map((m) => m.tauTicks), Infinity);
    return { label: t.label, count: ms.length, nextClose };
  });

  return (
    <div className="grid" style={{ gridTemplateColumns: '300px 1fr', alignItems: 'start' }}>
      {/* ---- left control column ---- */}
      <div className="col">
        <div className="panel">
          <h3>Pricing Engine <span className="hint">applies to all markets</span></h3>
          <Seg<EngineKind>
            options={[
              { v: 'LMSR', label: 'LMSR' },
              { v: 'CPMM', label: 'CPMM' },
              { v: 'LS-LMSR', label: 'LS-LMSR' },
            ]}
            value={sim.cfg.engine.kind}
            onChange={(v) => {
              sim.setEngineKind(v);
              refresh();
            }}
          />
          <p className="hint" style={{ marginTop: 8 }}>
            Feed-free: price = f(inventory q) only. Switching resets inventory.
          </p>
        </div>

        <div className="panel">
          <h3>Quoting Overlay <span className="hint">never mutates q</span></h3>
          <Seg<QuotingMode>
            options={[
              { v: 'manual', label: 'Manual' },
              { v: 'stoikov', label: 'Stoikov' },
            ]}
            value={q.mode}
            onChange={(v) => {
              sim.setQuote({ mode: v });
              refresh();
            }}
          />
          <div style={{ marginTop: 12 }}>
            {q.mode === 'manual' ? (
              <Slider
                label="half-spread s"
                value={q.manualHalfSpread}
                min={0.002}
                max={0.08}
                step={0.002}
                fmtVal={(v) => fmt(v * 100, 1) + '¢'}
                onChange={(v) => {
                  sim.setQuote({ manualHalfSpread: v });
                  refresh();
                }}
              />
            ) : (
              <>
                <Slider label="γ risk aversion" value={q.gamma} min={0.1} max={3} step={0.1}
                  onChange={(v) => { sim.setQuote({ gamma: v }); refresh(); }} />
                <Slider label="σ volatility" value={q.sigma} min={0.01} max={0.2} step={0.005}
                  onChange={(v) => { sim.setQuote({ sigma: v }); refresh(); }} />
                <Slider label="k order-arrival depth" value={q.k} min={5} max={200} step={5}
                  onChange={(v) => { sim.setQuote({ k: v }); refresh(); }} />
              </>
            )}
          </div>
        </div>

        <div className="panel">
          <h3>Agent Mix <span className="hint">agents are the market</span></h3>
          <Seg<AgentModel>
            options={[
              { v: 'behavioral', label: 'Behavioral' },
              { v: 'simple', label: 'Simple (v1)' },
            ]}
            value={sim.cfg.agentModel}
            onChange={(v) => {
              sim.setAgentModel(v);
              refresh();
            }}
          />
          <p className="hint" style={{ margin: '8px 0 12px' }}>
            {sim.cfg.agentModel === 'behavioral'
              ? 'Heterogeneous population: bursty arrivals, heavy-tailed sizes, favorite-longshot / momentum / contrarian / informed.'
              : 'Original v1 agents: noise / directional / arbitrageur. Kept for rollback.'}
          </p>
          <Slider label="noise" value={sim.cfg.noiseIntensity} min={0} max={3} step={0.1}
            onChange={(v) => { sim.setAgents({ noiseIntensity: v }); refresh(); }} />
          <Slider label="directional (skew)" value={sim.cfg.directionalIntensity} min={0} max={3} step={0.1}
            onChange={(v) => { sim.setAgents({ directionalIntensity: v }); refresh(); }} />
          <Slider label="arbitrageur (discovery)" value={sim.cfg.arbIntensity} min={0} max={3} step={0.1}
            onChange={(v) => { sim.setAgents({ arbIntensity: v }); refresh(); }} />
        </div>
      </div>

      {/* ---- right content column ---- */}
      <div className="col">
        <div className="panel">
          <h3>
            Synthetic BTC price <Provenance kind="sim" />
            <span className="hint"> · not a pricing input · est σ {fmt(state.estSigma * 100, 3)}%/tick</span>
          </h3>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={btcData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <XAxis dataKey="t" tick={{ fill: '#8a93a6', fontSize: 10 }} stroke="#232a3b" />
              <YAxis domain={['auto', 'auto']} tick={{ fill: '#8a93a6', fontSize: 10 }}
                stroke="#232a3b" width={52} tickFormatter={(v) => (v / 1000).toFixed(1) + 'k'} />
              <Tooltip contentStyle={{ background: '#131722', border: '1px solid #232a3b', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#8a93a6' }} formatter={(v) => ['$' + fmt(Number(v), 0), 'BTC']} />
              <Line type="monotone" dataKey="btc" stroke="var(--sim)" dot={false} strokeWidth={1.6} isAnimationActive={false} />
              {sel && <ReferenceLine y={sel.strike} stroke="#4dabf7" strokeDasharray="4 4"
                label={{ value: 'K ' + sel.strike, fill: '#4dabf7', fontSize: 10, position: 'insideTopRight' }} />}
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="panel">
          <h3>Rolling tenors <span className="hint">staggered windows · smoother aggregate risk</span></h3>
          <div className="strip">
            {tenors.map((t) => (
              <div className="cell" key={t.label}>
                <div className="lbl">{t.label} · {t.count} strike{t.count === 1 ? '' : 's'}</div>
                <div className="val">{ticksToClock(t.nextClose)}</div>
                <div className="hint">next roll</div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <h3>Markets <span className="hint">click a row to inspect its book · {state.markets.length} live</span></h3>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>tenor · strike</th><th>τ</th><th>P(YES)</th><th>bid</th><th>ask</th>
                  <th>reservation</th><th>qY</th><th>qN</th><th>skew</th><th>b</th>
                </tr>
              </thead>
              <tbody>
                {state.markets.map((m) => (
                  <tr key={m.id} className={'clickable ' + (sel?.id === m.id ? 'sel' : '')}
                    onClick={() => setSelId(m.id)}>
                    <td>{m.tenorLabel} · {fmt(m.strike, 0)}</td>
                    <td className="mut">{ticksToClock(m.tauTicks)}</td>
                    <td>{fmt(m.pYes, 3)}</td>
                    <td className="mut">{fmt(m.bid, 3)}</td>
                    <td className="mut">{fmt(m.ask, 3)}</td>
                    <td className="mut">{fmt(m.reservation, 3)}</td>
                    <td>{fmt(m.qY, 0)}</td>
                    <td>{fmt(m.qN, 0)}</td>
                    <td className={cls(m.netSkew)}>{fmt(m.netSkew, 0)}</td>
                    <td className="mut">{fmt(m.liquidityB, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {sel && (
          <div className="row">
            <div className="panel" style={{ flex: 1, minWidth: 280 }}>
              <h3>Order book — {sel.tenorLabel} · {fmt(sel.strike, 0)}
                <span className="hint"> ledger, not price-former</span></h3>
              <div className="kv" style={{ marginBottom: 8 }}>
                <span>engine mid (reference)</span>
                <span>{fmt(sel.pYes, 3)} · bid {fmt(sel.bid, 3)} / ask {fmt(sel.ask, 3)}</span>
              </div>
              <table>
                <thead><tr><th>side</th><th>limit</th><th>shares</th><th>actor</th></tr></thead>
                <tbody>
                  {sel.restingBids.length === 0 && (
                    <tr><td colSpan={4} className="mut" style={{ textAlign: 'center' }}>no resting orders</td></tr>
                  )}
                  {sel.restingBids.slice(0, 12).map((o, i) => (
                    <tr key={i}>
                      <td className={o.side === 'YES' ? 'pos' : 'neg'}>{o.side}</td>
                      <td>{fmt(o.limitPrice, 3)}</td>
                      <td>{fmt(o.shares, 1)}</td>
                      <td className="mut">{o.actor}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="panel" style={{ flex: 1, minWidth: 280 }}>
              <h3>Tape <span className="hint">recent trades · engine vs pair-mint</span></h3>
              <div className="tape">
                {sel.lastTrades.length === 0 && <div className="mut">no trades yet</div>}
                {sel.lastTrades.map((t, i) => (
                  <div className="line" key={i}>
                    <span className={t.side === 'YES' ? 'pos' : 'neg'}>
                      {t.side} {fmt(t.shares, 1)} @ {fmt(t.price, 3)}
                    </span>
                    <span className="mut">
                      {t.channel === 'engine' ? '⚙ engine' : '⇄ pair-mint'} · {t.actor}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
