import { useEffect, useRef, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import type { Simulation } from '../sim/sim';
import type { SimState, Side, EngineKind, QuotingMode } from '../sim/types';
import type { AgentModel } from '../sim/agents';
import { fmt, usd2, cls, ticksToClock } from './format';
import { Seg, Slider } from './widgets';

const TENOR = '5m';

interface UserPos { marketId: string; yes: number; no: number; cost: number; }

export function Page5Market({ sim, state, refresh }: { sim: Simulation; state: SimState; refresh: () => void; }) {
  const mkt = state.markets.find((m) => m.tenorLabel === TENOR) ?? null;

  const [size, setSize] = useState(10);
  const [pos, setPos] = useState<UserPos>({ marketId: '', yes: 0, no: 0, cost: 0 });
  const [realized, setRealized] = useState(0);
  const [wallet, setWallet] = useState(1000); // finite cash; resolves credit back on settlement
  const [showControls, setShowControls] = useState(true);

  // per-market probability history (resets each roll)
  const histRef = useRef<{ t: number; yes: number }[]>([]);
  const [, force] = useState(0);
  const prevRef = useRef<{ id: string; strike: number } | null>(null);

  useEffect(() => {
    if (!mkt) return;
    const prev = prevRef.current;
    // detect a roll: market id changed -> settle the old position, reset chart
    if (prev && prev.id !== mkt.id) {
      if (pos.marketId === prev.id && (pos.yes > 0 || pos.no > 0)) {
        const outcomeYes = state.btc > prev.strike;
        const payout = outcomeYes ? pos.yes : pos.no; // $1 per winning share
        setWallet((w) => w + payout); // settlement credits cash back
        setRealized((r) => r + (payout - pos.cost));
      }
      setPos({ marketId: mkt.id, yes: 0, no: 0, cost: 0 });
      histRef.current = [];
    } else if (pos.marketId === '') {
      setPos({ marketId: mkt.id, yes: 0, no: 0, cost: 0 });
    }
    prevRef.current = { id: mkt.id, strike: mkt.strike };

    const h = histRef.current;
    const last = h[h.length - 1];
    if (!last || last.t !== state.tick) {
      // build a NEW array (recharts freezes the data prop, so don't mutate it)
      histRef.current = [...h, { t: state.tick, yes: mkt.pYes * 100 }].slice(-600);
      force((x) => x + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tick, mkt?.id]);

  if (!mkt) {
    return <div className="panel" style={{ padding: 40, textAlign: 'center' }}>Waiting for the 5-minute market…</div>;
  }

  const yesPct = mkt.pYes * 100;
  const noPct = 100 - yesPct;
  const yesCost = size * mkt.ask; // pay the ask to buy YES
  const noCost = size * (1 - mkt.bid); // NO ask = 1 - YES bid

  const buy = (side: Side) => {
    const price = side === 'YES' ? mkt.ask : 1 - mkt.bid;
    // finite wallet: buy at most what the cash on hand allows
    const qty = Math.min(size, Math.floor((wallet / price) * 100) / 100);
    if (qty < 0.01) return; // can't afford
    const cost = qty * price;
    sim.userTrade(mkt.id, side, qty);
    setWallet((w) => w - cost);
    setPos((p) => ({
      marketId: mkt.id,
      yes: p.yes + (side === 'YES' ? qty : 0),
      no: p.no + (side === 'NO' ? qty : 0),
      cost: p.cost + cost,
    }));
    refresh();
  };

  // mark-to-model value of your position + unrealized P&L
  const posValue = pos.yes * mkt.pYes + pos.no * (1 - mkt.pYes);
  const unreal = posValue - pos.cost;
  const equity = wallet + posValue; // total account value (cash + open position)

  const yesBids = mkt.restingBids.filter((o) => o.side === 'YES').sort((a, b) => b.limitPrice - a.limitPrice).slice(0, 8);
  const noBids = mkt.restingBids.filter((o) => o.side === 'NO').sort((a, b) => b.limitPrice - a.limitPrice).slice(0, 8);

  return (
    <div className="col">
      {/* header */}
      <div className="panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontSize: 20 }}>Will BTC be ≥ ${fmt(mkt.strike, 0)} at resolution?</h2>
            <div className="hint" style={{ marginTop: 4 }}>
              5-minute rolling market · resolves in <b style={{ color: 'var(--text)' }}>{ticksToClock(mkt.tauTicks)}</b> · then a fresh market opens
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="hint">BTC spot (live)</div>
            <div style={{ fontSize: 26, fontVariantNumeric: 'tabular-nums' }}>${fmt(state.btc, 1)}</div>
            <div className={'hint ' + (state.btc >= mkt.strike ? 'pos' : 'neg')}>
              {state.btc >= mkt.strike ? 'above' : 'below'} strike by ${fmt(Math.abs(state.btc - mkt.strike), 0)}
            </div>
          </div>
        </div>
      </div>

      {/* research controls — engine / quoting / agents */}
      <div className="panel">
        <h3 style={{ display: 'flex', justifyContent: 'space-between', cursor: 'pointer', margin: 0 }}
          onClick={() => setShowControls((s) => !s)}>
          <span>Market controls <span className="hint">· AMM engine · quoting · agents</span></span>
          <span className="hint">{showControls ? '▲ hide' : '▼ show'}</span>
        </h3>
        {showControls && (
          <div className="row" style={{ gap: 24, marginTop: 12 }}>
            {/* engine */}
            <div style={{ flex: 1, minWidth: 200 }}>
              <div className="hint" style={{ marginBottom: 6 }}>Pricing engine <span className="hint">(switching resets inventory)</span></div>
              <Seg<EngineKind>
                options={[{ v: 'LMSR', label: 'LMSR' }, { v: 'CPMM', label: 'CPMM' }, { v: 'LS-LMSR', label: 'LS-LMSR' }]}
                value={sim.cfg.engine.kind}
                onChange={(v) => { sim.setEngineKind(v); refresh(); }}
              />
            </div>
            {/* quoting */}
            <div style={{ flex: 1, minWidth: 240 }}>
              <div className="hint" style={{ marginBottom: 6 }}>Quoting overlay</div>
              <Seg<QuotingMode>
                options={[{ v: 'manual', label: 'Manual' }, { v: 'stoikov', label: 'Stoikov' }]}
                value={sim.cfg.quote.mode}
                onChange={(v) => { sim.setQuote({ mode: v }); refresh(); }}
              />
              <div style={{ marginTop: 10 }}>
                {sim.cfg.quote.mode === 'manual' ? (
                  <Slider label="half-spread" value={sim.cfg.quote.manualHalfSpread} min={0.002} max={0.08} step={0.002}
                    fmtVal={(x) => fmt(x * 100, 1) + '¢'} onChange={(v) => { sim.setQuote({ manualHalfSpread: v }); refresh(); }} />
                ) : (
                  <>
                    <Slider label="γ risk aversion" value={sim.cfg.quote.gamma} min={0.1} max={3} step={0.1}
                      onChange={(v) => { sim.setQuote({ gamma: v }); refresh(); }} />
                    <Slider label="σ volatility" value={sim.cfg.quote.sigma} min={0.01} max={0.2} step={0.005}
                      onChange={(v) => { sim.setQuote({ sigma: v }); refresh(); }} />
                    <Slider label="k depth" value={sim.cfg.quote.k} min={5} max={200} step={5}
                      onChange={(v) => { sim.setQuote({ k: v }); refresh(); }} />
                  </>
                )}
              </div>
            </div>
            {/* agents */}
            <div style={{ flex: 1, minWidth: 240 }}>
              <div className="hint" style={{ marginBottom: 6 }}>Agents</div>
              <Seg<AgentModel>
                options={[{ v: 'behavioral', label: 'Behavioral' }, { v: 'simple', label: 'Simple (v1)' }]}
                value={sim.cfg.agentModel}
                onChange={(v) => { sim.setAgentModel(v); refresh(); }}
              />
              <div style={{ marginTop: 10 }}>
                <Slider label="noise" value={sim.cfg.noiseIntensity} min={0} max={3} step={0.1}
                  onChange={(v) => { sim.setAgents({ noiseIntensity: v }); refresh(); }} />
                <Slider label="directional" value={sim.cfg.directionalIntensity} min={0} max={3} step={0.1}
                  onChange={(v) => { sim.setAgents({ directionalIntensity: v }); refresh(); }} />
                <Slider label="arbitrageur" value={sim.cfg.arbIntensity} min={0} max={3} step={0.1}
                  onChange={(v) => { sim.setAgents({ arbIntensity: v }); refresh(); }} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* YES/NO big prices */}
      <div className="row">
        <div className="panel" style={{ flex: 1, borderLeft: '3px solid var(--green)' }}>
          <div className="hint">YES</div>
          <div style={{ fontSize: 34, color: 'var(--green)', fontVariantNumeric: 'tabular-nums' }}>{fmt(yesPct, 1)}¢</div>
          <div className="hint">ask {fmt(mkt.ask, 3)}</div>
        </div>
        <div className="panel" style={{ flex: 1, borderLeft: '3px solid var(--red)' }}>
          <div className="hint">NO</div>
          <div style={{ fontSize: 34, color: 'var(--red)', fontVariantNumeric: 'tabular-nums' }}>{fmt(noPct, 1)}¢</div>
          <div className="hint">ask {fmt(1 - mkt.bid, 3)}</div>
        </div>
      </div>

      <div className="row">
        {/* probability chart */}
        <div className="panel" style={{ flex: 2, minWidth: 420 }}>
          <h3>YES probability <span className="hint">· this market, since it opened</span></h3>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={histRef.current} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="yesg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--green)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="var(--green)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="t" tick={{ fill: '#8a93a6', fontSize: 10 }} stroke="#232a3b" />
              <YAxis domain={[0, 100]} tick={{ fill: '#8a93a6', fontSize: 10 }} stroke="#232a3b" width={36} tickFormatter={(v) => v + '¢'} />
              <Tooltip contentStyle={{ background: '#131722', border: '1px solid #232a3b', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#8a93a6' }} formatter={(v) => [fmt(Number(v), 1) + '¢', 'YES']} />
              <ReferenceLine y={50} stroke="#3a4357" strokeDasharray="3 3" />
              <Area type="monotone" dataKey="yes" stroke="var(--green)" fill="url(#yesg)" strokeWidth={1.8} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* trade panel */}
        <div className="panel" style={{ flex: 1, minWidth: 280 }}>
          <h3>Trade <span className="hint">· vs the engine</span></h3>
          <div className="field">
            <label><span>size (shares)</span><b>{size}</b></label>
            <input type="range" min={1} max={200} step={1} value={size} onChange={(e) => setSize(parseInt(e.target.value))} />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" disabled={wallet < yesCost && wallet < mkt.ask}
              style={{ flex: 1, background: 'var(--green)', borderColor: 'var(--green)', opacity: wallet < mkt.ask ? 0.4 : 1 }} onClick={() => buy('YES')}>
              Buy YES · {usd2(yesCost)}
            </button>
            <button className="btn primary" disabled={wallet < noCost && wallet < (1 - mkt.bid)}
              style={{ flex: 1, background: 'var(--red)', borderColor: 'var(--red)', opacity: wallet < (1 - mkt.bid) ? 0.4 : 1 }} onClick={() => buy('NO')}>
              Buy NO · {usd2(noCost)}
            </button>
          </div>
          <div style={{ marginTop: 14 }}>
            <div className="kv"><span>💰 wallet (cash)</span><span style={{ color: 'var(--text)', fontWeight: 600 }}>{usd2(wallet)}</span></div>
            <div className="kv"><span>position value</span><span>{usd2(posValue)}</span></div>
            <div className="kv"><span>equity (cash + pos)</span><span style={{ color: 'var(--accent)', fontWeight: 600 }}>{usd2(equity)}</span></div>
            <div className="kv" style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 6 }}><span>your YES</span><span>{fmt(pos.yes, 1)} sh</span></div>
            <div className="kv"><span>your NO</span><span>{fmt(pos.no, 1)} sh</span></div>
            <div className="kv"><span>cost basis</span><span>{usd2(pos.cost)}</span></div>
            <div className="kv"><span>unrealized</span><span className={cls(unreal)}>{usd2(unreal)}</span></div>
            <div className="kv"><span>realized (all rolls)</span><span className={cls(realized)}>{usd2(realized)}</span></div>
          </div>
        </div>
      </div>

      <div className="row">
        {/* order book */}
        <div className="panel" style={{ flex: 1, minWidth: 300 }}>
          <h3>Order book <span className="hint">· resting bids · engine mid {fmt(mkt.pYes, 3)}</span></h3>
          <div className="row" style={{ gap: 16 }}>
            <table style={{ flex: 1 }}>
              <thead><tr><th>YES bid</th><th>size</th></tr></thead>
              <tbody>
                {yesBids.length === 0 && <tr><td colSpan={2} className="mut">—</td></tr>}
                {yesBids.map((o, i) => <tr key={i}><td className="pos">{fmt(o.limitPrice, 3)}</td><td>{fmt(o.shares, 1)}</td></tr>)}
              </tbody>
            </table>
            <table style={{ flex: 1 }}>
              <thead><tr><th>NO bid</th><th>size</th></tr></thead>
              <tbody>
                {noBids.length === 0 && <tr><td colSpan={2} className="mut">—</td></tr>}
                {noBids.map((o, i) => <tr key={i}><td className="neg">{fmt(o.limitPrice, 3)}</td><td>{fmt(o.shares, 1)}</td></tr>)}
              </tbody>
            </table>
          </div>
        </div>

        {/* recent trades */}
        <div className="panel" style={{ flex: 1, minWidth: 300 }}>
          <h3>Recent trades</h3>
          <div className="tape">
            {mkt.lastTrades.length === 0 && <div className="mut">no trades yet</div>}
            {mkt.lastTrades.slice(0, 14).map((t, i) => (
              <div className="line" key={i}>
                <span className={t.side === 'YES' ? 'pos' : 'neg'}>{t.side} {fmt(t.shares, 1)} @ {fmt(t.price, 3)}</span>
                <span className="mut">{t.channel === 'engine' ? '⚙' : '⇄'} {t.actor}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
