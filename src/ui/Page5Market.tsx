import { useEffect, useRef, useState } from 'react';
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import type { Simulation } from '../sim/sim';
import type { SimState, Side, EngineKind, QuotingMode } from '../sim/types';
import type { AgentModel } from '../sim/agents';
import { fmt, usd, usd2, cls, ticksToClock } from './format';
import { Seg, Slider } from './widgets';
import { useHedgeControl } from './useHedgeControl';
import { defaultConfig } from '../sim/config';

const TENOR = '5m';

interface UserPos { marketId: string; yes: number; no: number; cost: number; }

// ---- Hedge Risk Lab: live perp overlays on the same agent flow ----
// 5m reduce-only window (60s) — matches the per-tenor lockout the engine enforces.
const LOCKOUT_TICKS = defaultConfig.expiryLockoutTicks5m;
const LAB_BUDGET = 10000;       // full-budget notional cap
const LAB_FEE_BPS = 2;          // per-side hedge fee (so the cost shows)
// vol gate (mirror of server/src/config.ts defaults) — 'gated' only hedges when
// realized per-tick vol breaches the threshold; flat (like 'none') when calm.
const LAB_VOL_WINDOW = 60;
const LAB_VOL_THRESHOLD = 0.0005;
const LAB_VOL_HYST = 0.6;
type LabStrat = 'none' | 'delta' | 'sentiment' | 'combined' | 'gated';
const LAB_STRATS: LabStrat[] = ['none', 'delta', 'sentiment', 'combined', 'gated'];
interface OBook { pos: number; avg: number; realized: number; fees: number; }
const newBook = (): OBook => ({ pos: 0, avg: 0, realized: 0, fees: 0 });
function obReconcile(b: OBook, target: number, spot: number) {
  const trade = target - b.pos;
  if (Math.abs(trade) < 1e-7) return;
  b.fees += Math.abs(trade) * spot * (LAB_FEE_BPS / 1e4);
  if (b.pos !== 0 && Math.sign(trade) !== Math.sign(b.pos)) {
    const closed = Math.min(Math.abs(trade), Math.abs(b.pos));
    b.realized += Math.sign(b.pos) * closed * (spot - b.avg);
    const rem = b.pos + trade;
    if (Math.sign(rem) === Math.sign(trade) && rem !== 0) b.avg = spot;
    b.pos = rem;
  } else {
    const np = b.pos + trade;
    b.avg = np !== 0 ? (b.pos * b.avg + trade * spot) / np : 0;
    b.pos = np;
  }
}
const obPnl = (b: OBook, spot: number) => b.realized + b.pos * (spot - b.avg) - b.fees;
const labClamp = (x: number, c: number) => Math.max(-c, Math.min(c, x));
function stdevInc(a: number[]): number {
  if (a.length < 3) return 0;
  const d: number[] = []; for (let i = 1; i < a.length; i++) d.push(a[i] - a[i - 1]);
  const m = d.reduce((x, y) => x + y, 0) / d.length;
  return Math.sqrt(d.reduce((x, y) => x + (y - m) ** 2, 0) / d.length);
}
function maxDD(a: number[]): number { let p = -Infinity, dd = 0; for (const v of a) { p = Math.max(p, v); dd = Math.max(dd, p - v); } return dd; }
const LAB_COLOR: Record<LabStrat, string> = { none: 'var(--muted)', delta: 'var(--bookA)', sentiment: 'var(--bookC)', combined: 'var(--green)', gated: 'var(--accent)' };

export function Page5Market({ sim, state, refresh }: { sim: Simulation; state: SimState; refresh: () => void; }) {
  const mkt = state.markets.find((m) => m.tenorLabel === TENOR) ?? null;

  const hedgeCtl = useHedgeControl();
  const [gateEdit, setGateEdit] = useState<{ notional?: string; vol?: string }>({});
  const [size, setSize] = useState(10);
  // Per-window settlement card: baselines captured at each market's open, diffed
  // when it rolls. Vig/inventory come from the sim book (this market); hedging/
  // fees come from the real demo account (backend).
  const winBaseRef = useRef<{ vig: number; inv: number; equity: number | null; fees: number } | null>(null);
  const [settleCard, setSettleCard] = useState<null | {
    strike: number; outcomeYes: boolean; vig: number; invPnl: number;
    hedgeGross: number | null; fees: number; net: number;
  }>(null);
  const [pos, setPos] = useState<UserPos>({ marketId: '', yes: 0, no: 0, cost: 0 });
  const [realized, setRealized] = useState(0);
  const [wallet, setWallet] = useState(1000); // finite cash; resolves credit back on settlement
  const [showControls, setShowControls] = useState(true);

  // per-market probability history (resets each roll)
  const histRef = useRef<{ t: number; yes: number }[]>([]);
  const [, force] = useState(0);
  const prevRef = useRef<{ id: string; strike: number } | null>(null);
  const prevTickRef = useRef(0);

  // Hedge Risk Lab: 4 perp overlays on the same flow + their net equity curves
  const newBooks = (): Record<LabStrat, OBook> =>
    ({ none: newBook(), delta: newBook(), sentiment: newBook(), combined: newBook(), gated: newBook() });
  const labBooks = useRef<Record<LabStrat, OBook>>(newBooks());
  const labSeries = useRef<Array<{ t: number } & Record<LabStrat, number>>>([]);
  const labTickRef = useRef(-1);
  // vol gate state for the 'gated' overlay
  const labReturns = useRef<number[]>([]);
  const labPrevSpot = useRef(0);
  const labGateOn = useRef(false);
  const [labVol, setLabVol] = useState(0);

  // topbar Reset rewinds the sim (tick → 0): flatten the user's holdings too so
  // both parties start from no positions; also reset the lab overlays.
  useEffect(() => {
    if (state.tick < prevTickRef.current) {
      setWallet(1000);
      setPos({ marketId: '', yes: 0, no: 0, cost: 0 });
      setRealized(0);
      histRef.current = [];
      prevRef.current = null;
      labBooks.current = newBooks();
      labSeries.current = [];
      labReturns.current = [];
      labPrevSpot.current = 0;
      labGateOn.current = false;
      setLabVol(0);
      winBaseRef.current = null;
      setSettleCard(null);
    }
    prevTickRef.current = state.tick;
  }, [state.tick]);

  // advance the lab overlays once per tick (guarded vs StrictMode double-fire)
  useEffect(() => {
    const c = state.books.find((b) => b.id === 'C');
    if (!c || state.tick === labTickRef.current) return;
    labTickRef.current = state.tick;
    const spot = state.btc;
    const common = c.spreadCapture + c.inventoryPnl;
    const delta = state.aggregateDelta;
    const lean = state.sentiment?.lean ?? 0;
    const cap = LAB_BUDGET / spot;

    // realized-vol gate for the 'gated' overlay (same logic as the live runner)
    if (labPrevSpot.current > 0 && spot > 0) {
      labReturns.current.push(spot / labPrevSpot.current - 1);
      if (labReturns.current.length > LAB_VOL_WINDOW) labReturns.current.shift();
    }
    labPrevSpot.current = spot;
    let vol = labVol;
    if (labReturns.current.length >= 5) {
      const r = labReturns.current;
      const mean = r.reduce((a, b) => a + b, 0) / r.length;
      vol = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length);
      setLabVol(vol);
    }
    if (!labGateOn.current && vol >= LAB_VOL_THRESHOLD) labGateOn.current = true;
    else if (labGateOn.current && vol < LAB_VOL_THRESHOLD * LAB_VOL_HYST) labGateOn.current = false;

    const combinedTarget = labClamp(delta + 0.5 * cap * lean, cap);
    const targets: Record<LabStrat, number> = {
      none: 0,
      delta: labClamp(delta, cap),
      sentiment: labClamp(lean * cap, cap),
      combined: combinedTarget,
      gated: labGateOn.current ? combinedTarget : 0,
    };
    const row: any = { t: state.tick };
    for (const st of LAB_STRATS) {
      obReconcile(labBooks.current[st], targets[st], spot);
      row[st] = common + obPnl(labBooks.current[st], spot);
    }
    labSeries.current = [...labSeries.current, row].slice(-600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tick]);

  useEffect(() => {
    if (!mkt) return;
    const prev = prevRef.current;
    // current cumulative figures: vig+inventory from the sim book (common across
    // A/B/C), equity+fees from the real demo account.
    const bk0 = state.books[0];
    const cumVig = bk0?.spreadCapture ?? 0;
    const cumInv = bk0?.inventoryPnl ?? 0;
    const eqNow = hedgeCtl.status?.equity ?? null;
    const feesNow = hedgeCtl.status?.feesPaid ?? 0;
    // detect a roll: market id changed -> settle the old position, reset chart
    if (prev && prev.id !== mkt.id) {
      if (pos.marketId === prev.id && (pos.yes > 0 || pos.no > 0)) {
        const outcomeYes = state.btc >= prev.strike; // ≥ = displayed contract
        const payout = outcomeYes ? pos.yes : pos.no; // $1 per winning share
        setWallet((w) => w + payout); // settlement credits cash back
        setRealized((r) => r + (payout - pos.cost));
      }
      // build the per-window P&L card from the baseline captured at open
      const b = winBaseRef.current;
      if (b) {
        const vig = cumVig - b.vig;
        const invPnl = cumInv - b.inv;
        const fees = feesNow - b.fees;
        const hedgeNet = eqNow != null && b.equity != null ? eqNow - b.equity : null;
        const hedgeGross = hedgeNet != null ? hedgeNet + fees : null; // add fees back
        const net = vig + invPnl + (hedgeNet ?? 0);
        setSettleCard({ strike: prev.strike, outcomeYes: state.btc >= prev.strike, vig, invPnl, hedgeGross, fees, net });
      }
      winBaseRef.current = { vig: cumVig, inv: cumInv, equity: eqNow, fees: feesNow };
      setPos({ marketId: mkt.id, yes: 0, no: 0, cost: 0 });
      histRef.current = [];
    } else if (pos.marketId === '') {
      setPos({ marketId: mkt.id, yes: 0, no: 0, cost: 0 });
    }
    if (!winBaseRef.current) winBaseRef.current = { vig: cumVig, inv: cumInv, equity: eqNow, fees: feesNow };
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
    const cost = sim.userTrade(mkt.id, side, qty); // exact engine charge
    if (cost <= 0) { refresh(); return; } // rejected (expiry reduce-only lockout)
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
      {/* per-window settlement P&L card (modal) */}
      {settleCard && (() => {
        const c = settleCard;
        const row = (label: string, val: number | null, hint: string) => (
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
            <div><div>{label}</div><div className="hint">{hint}</div></div>
            <div className={'val ' + (val == null ? 'mut' : cls(val))} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {val == null ? '—' : usd2(val)}
            </div>
          </div>
        );
        return (
          <div onClick={() => setSettleCard(null)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="panel" onClick={(e) => e.stopPropagation()} style={{ width: 420, maxWidth: '90vw', boxShadow: '0 12px 48px rgba(0,0,0,0.5)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <h3 style={{ margin: 0 }}>5m market settled</h3>
                <span className={'tag ' + (c.outcomeYes ? 'deploy' : 'sim')}>{c.outcomeYes ? 'YES' : 'NO'} · ${fmt(c.strike, 0)}</span>
              </div>
              <div className="hint" style={{ margin: '6px 0 10px' }}>P&amp;L breakdown for the market that just resolved.</div>
              {row('Vig (spread captured)', c.vig, 'the fee earned on flow — revenue')}
              {row('Inventory P&L', c.invPnl, 'payouts to correct traders (− = house paid out)')}
              {row('Hedging (Binance position)', c.hedgeGross, 'perp P&L over the window (real demo)')}
              {row('Fees (to Binance)', c.fees === 0 ? 0 : -c.fees, 'taker fees on hedge buys/sells')}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0 2px', fontWeight: 600 }}>
                <div>Net market P&amp;L</div>
                <div className={'val ' + cls(c.net)} style={{ fontVariantNumeric: 'tabular-nums' }}>{usd2(c.net)}</div>
              </div>
              <div className="hint" style={{ marginTop: 8 }}>Vig/Inventory = this market (sim). Hedging/Fees = live demo account over the window.</div>
              <button className="btn primary" style={{ marginTop: 12, width: '100%' }} onClick={() => setSettleCard(null)}>Close</button>
            </div>
          </div>
        );
      })()}

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

      {/* Binance demo hedge — on/off control */}
      {(() => {
        const h = hedgeCtl.status;
        const on = !!h?.hedgeEnabled;
        const live = h && !h.dryRun && h.hasKeys;
        return (
          <div className="panel" style={{ borderLeft: `3px solid ${on ? 'var(--green)' : 'var(--border)'}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div>
                <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  Binance hedge (demo)
                  <span className="hint">· {hedgeCtl.connected ? `${h?.hedgeMode ?? ''} mode` : 'backend offline'}</span>
                  {h && hedgeCtl.connected && (
                    <label className="hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      · leverage
                      <select value={h.leverage} onChange={(e) => hedgeCtl.setLeverage(Number(e.target.value))}
                        style={{ background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 4px' }}>
                        {[1, 2, 3, 5, 10, 20].map((x) => <option key={x} value={x}>{x}x</option>)}
                      </select>
                    </label>
                  )}
                </h3>
                <div className="hint" style={{ marginTop: 4 }}>
                  {!hedgeCtl.connected ? 'start the server (cd server && npm start)'
                    : !h?.hasKeys ? 'no API keys in server/.env'
                    : on ? (live ? '● LIVE — placing real demo perp orders' : '○ ON — dry-run (set DRY_RUN=false in .env for real orders)')
                    : 'hedging off — no orders being placed'}
                  {h && hedgeCtl.connected && (
                    <> · pos {fmt(h.livePosition, 4)} BTC{h.equity != null ? ` · equity ${usd2(h.equity)}` : ''}</>
                  )}
                  {h?.hedgeError && <span className="neg"> · {h.hedgeError.slice(0, 60)}</span>}
                </div>
                {h && hedgeCtl.connected && (
                  <div className="hint" style={{ marginTop: 4 }}>
                    vol {(h.realizedVol * 100).toFixed(3)}%/{(h.volThreshold * 100).toFixed(3)}% ·
                    {' '}inv ${fmt(h.notionalUsdt ?? 0, 0)}/${fmt(h.notionalGate ?? 0, 0)} ·{' '}
                    {h.idleReason === 'armed'
                      ? <span className="pos">▲ ARMED — both gates open, hedging active</span>
                      : h.idleReason === 'idle-vol'
                        ? <span style={{ color: 'var(--muted)' }}>idle · vol below threshold (calm)</span>
                        : h.idleReason === 'idle-inv'
                          ? <span style={{ color: 'var(--muted)' }}>idle · inventory below gate (little at risk)</span>
                          : h.idleReason === 'disabled'
                            ? <span style={{ color: 'var(--muted)' }}>off</span>
                            : <span style={{ color: 'var(--muted)' }}>warming up…</span>}
                  </div>
                )}
                {h && hedgeCtl.connected && h.hasKeys && (
                  <div className="hint" style={{ marginTop: 6, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span>tune gates →</span>
                    <label>inv gate $
                      <input type="number" min={0} step={10} style={{ width: 64, marginLeft: 4 }}
                        value={gateEdit.notional ?? String(Math.round(h.notionalGate))}
                        onChange={(e) => setGateEdit((g) => ({ ...g, notional: e.target.value }))}
                        onBlur={() => { if (gateEdit.notional != null) { hedgeCtl.setGates({ notionalUsdt: parseFloat(gateEdit.notional) }); setGateEdit((g) => ({ ...g, notional: undefined })); } }}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                    </label>
                    <button className="btn" style={{ padding: '1px 8px', fontSize: 11, opacity: h.gateMode === 'adaptive' ? 1 : 0.55 }}
                      title="adaptive: gate self-calibrates to a percentile of the last hour's exposure (typing a $ switches to fixed)"
                      onClick={() => hedgeCtl.setGates({ mode: h.gateMode === 'adaptive' ? 'fixed' : 'adaptive' })}>
                      {h.gateMode === 'adaptive' ? `auto p${Math.round((h.gatePctl ?? 0.6) * 100)}` : 'fixed → auto?'}
                    </button>
                    <span className="mut">(live ${fmt(h.notionalUsdt, 0)})</span>
                    <label>vol thr
                      <input type="number" min={0} step={0.00005} style={{ width: 84, marginLeft: 4 }}
                        value={gateEdit.vol ?? String(h.volThreshold)}
                        onChange={(e) => setGateEdit((g) => ({ ...g, vol: e.target.value }))}
                        onBlur={() => { if (gateEdit.vol != null) { hedgeCtl.setGates({ volThreshold: parseFloat(gateEdit.vol) }); setGateEdit((g) => ({ ...g, vol: undefined })); } }}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                    </label>
                    <span className="mut">(live {h.realizedVol.toFixed(5)})</span>
                  </div>
                )}
              </div>
              <button
                className={'btn ' + (on ? 'danger' : 'primary')}
                disabled={!hedgeCtl.connected || !h?.hasKeys}
                style={on ? { background: 'var(--red)', borderColor: 'var(--red)' } : { background: 'var(--green)', borderColor: 'var(--green)' }}
                onClick={() => hedgeCtl.setEnabled(!on)}
              >
                {on ? '■ Turn hedge OFF' : '▶ Turn hedge ON'}
              </button>
            </div>
          </div>
        );
      })()}

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
          {mkt.tauTicks > 0 && mkt.tauTicks <= LOCKOUT_TICKS && (
            <div className="hint" style={{ margin: '0 0 8px', color: 'var(--accent)' }}>
              ⏳ resolution lockout (last {LOCKOUT_TICKS}s) — reduce-only; trades that add inventory at the gamma wall are rejected.
            </div>
          )}
          {(() => {
            // reduce-only near expiry: the engine rejects trades that GROW the
            // house's one-sided inventory. Buying YES grows netSkew when it's
            // ≥0; buying NO grows it when ≤0. Gray out the blocked side (Polymarket-
            // style) so the user isn't surprised by a silent rejection.
            const inLockout = mkt.tauTicks > 0 && mkt.tauTicks <= LOCKOUT_TICKS;
            const yesBlocked = inLockout && mkt.netSkew >= 0;
            const noBlocked = inLockout && mkt.netSkew <= 0;
            const yesDisabled = yesBlocked || (wallet < yesCost && wallet < mkt.ask);
            const noDisabled = noBlocked || (wallet < noCost && wallet < (1 - mkt.bid));
            return (
              <div className="row" style={{ gap: 8 }}>
                <button className="btn primary" disabled={yesDisabled}
                  title={yesBlocked ? 'Reduce-only near expiry — YES adds inventory, blocked' : ''}
                  style={{ flex: 1, background: 'var(--green)', borderColor: 'var(--green)', opacity: yesDisabled ? 0.4 : 1 }} onClick={() => buy('YES')}>
                  {yesBlocked ? '🔒 YES locked' : `Buy YES · ${usd2(yesCost)}`}
                </button>
                <button className="btn primary" disabled={noDisabled}
                  title={noBlocked ? 'Reduce-only near expiry — NO adds inventory, blocked' : ''}
                  style={{ flex: 1, background: 'var(--red)', borderColor: 'var(--red)', opacity: noDisabled ? 0.4 : 1 }} onClick={() => buy('NO')}>
                  {noBlocked ? '🔒 NO locked' : `Buy NO · ${usd2(noCost)}`}
                </button>
              </div>
            );
          })()}
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

      {/* P&L & money flow — who's making/losing money */}
      {(() => {
        const bk = state.books.find((b) => b.id === 'C');
        if (!bk) return null;
        const mmNet = bk.spreadCapture + bk.inventoryPnl + bk.hedgePnl;
        const agentPnl = state.agentStats?.pnl ?? 0;
        return (
          <div className="panel">
            <h3>P&amp;L &amp; money flow <span className="hint">· market maker vs the crowd</span></h3>
            <div className="strip">
              <div className="cell"><div className="lbl">MM spread captured</div><div className="val pos">{usd2(bk.spreadCapture)}</div><div className="hint">the vig (revenue)</div></div>
              <div className="cell"><div className="lbl">MM inventory P&amp;L</div><div className={'val ' + cls(bk.inventoryPnl)}>{usd2(bk.inventoryPnl)}</div><div className="hint">skew + LMSR subsidy (− = loss)</div></div>
              <div className="cell"><div className="lbl">hedge P&amp;L</div><div className={'val ' + cls(bk.hedgePnl)}>{usd2(bk.hedgePnl)}</div><div className="hint">perp cost / offset</div></div>
              <div className="cell"><div className="lbl">market-maker NET</div><div className={'val ' + cls(mmNet)}>{usd2(mmNet)}</div><div className="hint">spread + inv + hedge</div></div>
              <div className="cell"><div className="lbl">agents NET P&amp;L</div><div className={'val ' + cls(agentPnl)}>{usd2(agentPnl)}</div><div className="hint">the crowd, realised</div></div>
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              The crowd's gains come from the MM's inventory loss + the LMSR liquidity subsidy, partly clawed back by the spread (vig). The hedge converts inventory *direction* risk into a small, steady cost.
            </p>
          </div>
        );
      })()}

      {/* Hedge Risk Lab — does hedging reduce risk on THIS flow? */}
      {(() => {
        const S = labSeries.current;
        if (S.length < 5) return (
          <div className="panel"><h3>Hedge risk lab <span className="hint">· collecting data…</span></h3></div>
        );
        const metric = (st: LabStrat) => {
          const arr = S.map((r) => r[st]);
          return { net: arr[arr.length - 1], vol: stdevInc(arr), dd: maxDD(arr) };
        };
        const m = Object.fromEntries(LAB_STRATS.map((st) => [st, metric(st)])) as Record<LabStrat, ReturnType<typeof metric>>;
        const baseDD = m.none.dd || 1e-9;
        const baseVol = m.none.vol || 1e-9;
        return (
          <div className="panel">
            <h3>Hedge risk lab <span className="hint">· same agent flow, five perp overlays sized to ${LAB_BUDGET} · vol {(labVol * 100).toFixed(3)}% (gate {(LAB_VOL_THRESHOLD * 100).toFixed(3)}%, {labGateOn.current ? 'ARMED' : 'idle'}) · does hedging cut risk?</span></h3>
            <div className="row" style={{ gap: 16 }}>
              <div style={{ flex: 1, minWidth: 320 }}>
                <table>
                  <thead><tr><th>strategy</th><th>net P&amp;L</th><th>P&amp;L vol</th><th>max drawdown</th><th>vs unhedged</th></tr></thead>
                  <tbody>
                    {LAB_STRATS.map((st) => (
                      <tr key={st}>
                        <td><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: LAB_COLOR[st], marginRight: 6 }} />{st}</td>
                        <td className={cls(m[st].net)}>{usd2(m[st].net)}</td>
                        <td className="mut">{fmt(m[st].vol, 2)}</td>
                        <td className="neg">{usd2(-m[st].dd)}</td>
                        <td className={st === 'none' ? 'mut' : (m[st].dd < baseDD ? 'pos' : 'neg')}>
                          {st === 'none' ? '—' : `${(((baseDD - m[st].dd) / baseDD) * 100).toFixed(0)}% DD, ${(((baseVol - m[st].vol) / baseVol) * 100).toFixed(0)}% vol`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="hint" style={{ marginTop: 6 }}>
                  Positive "vs unhedged" = lower risk than no hedge. Always-on hedges (delta/sentiment/combined) bleed fees in calm markets; <b>gated</b> only hedges when realized vol breaches the threshold — so it tracks unhedged when calm and captures the protection when BTC moves. That's the regime where hedging beats not hedging.
                </p>
              </div>
              <div style={{ flex: 1, minWidth: 320 }}>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={S} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                    <XAxis dataKey="t" tick={{ fill: '#8a93a6', fontSize: 10 }} stroke="#232a3b" />
                    <YAxis tick={{ fill: '#8a93a6', fontSize: 10 }} stroke="#232a3b" width={50} tickFormatter={(v) => usd(Number(v))} />
                    <Tooltip contentStyle={{ background: '#131722', border: '1px solid #232a3b', borderRadius: 8, fontSize: 12 }} labelStyle={{ color: '#8a93a6' }} formatter={(v, n) => [usd2(Number(v)), n]} />
                    {LAB_STRATS.map((st) => (
                      <Line key={st} type="monotone" dataKey={st} stroke={LAB_COLOR[st]} dot={false} strokeWidth={st === 'none' ? 1 : 1.6} isAnimationActive={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        );
      })()}

      {/* agent population wealth — the reward signal */}
      {state.agentStats && (
        <div className="panel">
          <h3>Agent population <span className="hint">· wallets are their reward: winners trade more, broke agents drop out</span></h3>
          <div className="strip">
            <div className="cell"><div className="lbl">active traders</div><div className="val">{state.agentStats.active}/{state.agentStats.count}</div><div className="hint">balance ≥ min</div></div>
            <div className="cell"><div className="lbl">bankrupt</div><div className="val neg">{state.agentStats.bankrupt}</div><div className="hint">dropped out</div></div>
            <div className="cell"><div className="lbl">in profit</div><div className="val pos">{state.agentStats.winners}</div><div className="hint">above starting bankroll</div></div>
            <div className="cell"><div className="lbl">avg balance</div><div className="val">{usd2(state.agentStats.avgBalance)}</div><div className="hint">per trader</div></div>
            <div className="cell"><div className="lbl">total capital</div><div className="val">{usd2(state.agentStats.totalBalance)}</div><div className="hint">richest {usd2(state.agentStats.richest)}</div></div>
          </div>
        </div>
      )}
    </div>
  );
}
