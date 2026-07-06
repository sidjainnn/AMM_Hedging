// A/B window ledger — the measurement instrument for the hedged-vs-unhedged
// experiment. One CSV row per settled 5m window of the SERVER book (the book
// the demo account actually hedges), capturing:
//   - book components (spread, inventory) → the exact unhedged counterfactual
//   - the real hedge leg (account equity Δ, fills, measured slippage, est fees)
//   - gate/regime context (armed fraction, realized vol, effective gate)
//   - exclusion flags (stale feed ticks, partial window)
// The hedge never feeds back into the book, so unhedged = spread+inv from the
// SAME window is an exact paired counterfactual (validate with OFF blocks).
//
// View it: open server/data/ledger.csv in Excel/Numbers, GET /api/ledger.csv,
// or GET /api/ledger (JSON) — also rendered as a table on the Live tab.

import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
const CSV_PATH = path.join(DATA_DIR, 'ledger.csv');

export const LEDGER_COLUMNS = [
  'ts_close', 'session', 'win', 'strike', 'outcome', 'btc_open', 'btc_close',
  'spread_usd', 'inv_usd', 'unhedged_net',
  'equity_open', 'equity_close', 'hedge_pnl', 'hedged_net',
  'fees_est', 'slippage_usd', 'fills', 'notional_traded',
  'enabled_frac', 'armed_frac', 'idle_inv_frac', 'idle_vol_frac',
  'gate_mode', 'effective_gate', 'realized_vol',
  'stale_ticks', 'partial', 'excluded',
] as const;

export type LedgerRow = Record<(typeof LEDGER_COLUMNS)[number], string | number>;

// Baseline captured at a window's open; deltas are computed at close.
export interface WindowBaseline {
  btc: number;
  strike: number;
  spread: number;
  inv: number;
  equity: number | null;
  fees: number;
  slippage: number;
  fills: number;
  notionalTraded: number;
}

export class WindowLedger {
  private session = new Date().toISOString();
  private winIndex = 0;
  private base: WindowBaseline | null = null;
  private firstWindow = true; // boot lands mid-window → first close is partial

  // per-window accumulators (reset each window)
  private ticks = 0;
  private enabledTicks = 0;
  private armedTicks = 0;
  private idleInvTicks = 0;
  private idleVolTicks = 0;
  private staleTicks = 0;
  private volSum = 0;

  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CSV_PATH)) {
      fs.writeFileSync(CSV_PATH, LEDGER_COLUMNS.join(',') + '\n');
    }
  }

  open(base: WindowBaseline): void {
    this.base = base;
    this.ticks = this.enabledTicks = this.armedTicks = 0;
    this.idleInvTicks = this.idleVolTicks = this.staleTicks = 0;
    this.volSum = 0;
  }

  tick(s: { enabled: boolean; idleReason: string; stale: boolean; realizedVol: number }): void {
    this.ticks++;
    if (s.enabled) this.enabledTicks++;
    if (s.idleReason === 'armed') this.armedTicks++;
    if (s.idleReason === 'idle-inv') this.idleInvTicks++;
    if (s.idleReason === 'idle-vol') this.idleVolTicks++;
    if (s.stale) this.staleTicks++;
    this.volSum += s.realizedVol;
  }

  // Close the current window against `now` values; append one CSV row.
  close(now: {
    btc: number;
    spread: number;
    inv: number;
    equity: number | null;
    fees: number;
    slippage: number;
    fills: number;
    notionalTraded: number;
    gateMode: string;
    effectiveGate: number;
  }): LedgerRow | null {
    const b = this.base;
    if (!b) return null;
    const spread = now.spread - b.spread;
    const inv = now.inv - b.inv;
    const unhedged = spread + inv;
    const hedgePnl = now.equity != null && b.equity != null ? now.equity - b.equity : null;
    const partial = this.firstWindow;
    this.firstWindow = false;
    const n = (x: number, d = 2) => Number(x.toFixed(d));
    const row: LedgerRow = {
      ts_close: new Date().toISOString(),
      session: this.session,
      win: this.winIndex++,
      strike: b.strike,
      outcome: now.btc >= b.strike ? 'YES' : 'NO',
      btc_open: n(b.btc, 1),
      btc_close: n(now.btc, 1),
      spread_usd: n(spread),
      inv_usd: n(inv),
      unhedged_net: n(unhedged),
      equity_open: b.equity != null ? n(b.equity) : '',
      equity_close: now.equity != null ? n(now.equity) : '',
      hedge_pnl: hedgePnl != null ? n(hedgePnl) : '',
      hedged_net: hedgePnl != null ? n(unhedged + hedgePnl) : '',
      fees_est: n(now.fees - b.fees, 4),
      slippage_usd: n(now.slippage - b.slippage, 4),
      fills: now.fills - b.fills,
      notional_traded: n(now.notionalTraded - b.notionalTraded),
      enabled_frac: this.frac(this.enabledTicks),
      armed_frac: this.frac(this.armedTicks),
      idle_inv_frac: this.frac(this.idleInvTicks),
      idle_vol_frac: this.frac(this.idleVolTicks),
      gate_mode: now.gateMode,
      effective_gate: n(now.effectiveGate),
      realized_vol: this.ticks ? Number((this.volSum / this.ticks).toExponential(3)) : 0,
      stale_ticks: this.staleTicks,
      partial: partial ? 1 : 0,
      excluded: partial || this.staleTicks > 0 ? 1 : 0, // pre-registered exclusion rule
    };
    fs.appendFileSync(CSV_PATH, LEDGER_COLUMNS.map((c) => row[c]).join(',') + '\n');
    return row;
  }

  private frac(t: number): number {
    return this.ticks ? Number((t / this.ticks).toFixed(3)) : 0;
  }

  csvPath(): string {
    return CSV_PATH;
  }

  // last N rows parsed back to objects (for /api/ledger and the UI table)
  rows(limit = 50): LedgerRow[] {
    try {
      const lines = fs.readFileSync(CSV_PATH, 'utf8').trim().split('\n');
      const header = lines[0].split(',');
      return lines.slice(1).slice(-limit).map((ln) => {
        const cells = ln.split(',');
        const o: Record<string, string | number> = {};
        header.forEach((h, i) => {
          const v = cells[i] ?? '';
          o[h] = v === '' || isNaN(Number(v)) ? v : Number(v);
        });
        return o as LedgerRow;
      });
    } catch {
      return [];
    }
  }
}
