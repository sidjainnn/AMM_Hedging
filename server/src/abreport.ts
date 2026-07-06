// A/B analysis — reads data/ledger.csv and reports whether hedging removed
// risk per dollar of cost, per the pre-registered protocol (docs/ab-protocol.md).
//
//   cd server && npx tsx src/abreport.ts
//
// Design recap: the hedge never feeds back into the book, so every HEDGED
// window carries its own exact unhedged counterfactual (unhedged_net = vig+inv)
// — a paired within-window comparison. UNHEDGED (validation) windows check the
// identity: their hedge_pnl must be ≈ 0 (equity noise only).

import fs from 'node:fs';
import path from 'node:path';

const CSV = path.join(process.cwd(), 'data', 'ledger.csv');

interface Row {
  unhedged: number; hedged: number; hedgePnl: number;
  fees: number; slip: number; fills: number;
  enabledFrac: number; armedFrac: number; vol: number; excluded: number;
}

function load(): Row[] {
  const lines = fs.readFileSync(CSV, 'utf8').trim().split('\n');
  const h = lines[0].split(',');
  const col = (name: string) => h.indexOf(name);
  const c = {
    un: col('unhedged_net'), hd: col('hedged_net'), hp: col('hedge_pnl'),
    fe: col('fees_est'), sl: col('slippage_usd'), fi: col('fills'),
    en: col('enabled_frac'), ar: col('armed_frac'), vo: col('realized_vol'), ex: col('excluded'),
  };
  return lines.slice(1).map((ln) => {
    const v = ln.split(',');
    const n = (i: number) => parseFloat(v[i]) || 0;
    return {
      unhedged: n(c.un), hedged: n(c.hd), hedgePnl: v[c.hp] === '' ? NaN : n(c.hp),
      fees: n(c.fe), slip: n(c.sl), fills: n(c.fi),
      enabledFrac: n(c.en), armedFrac: n(c.ar), vol: n(c.vo), excluded: n(c.ex),
    };
  });
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const std = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const worst = (a: number[]) => Math.min(...a);
function maxDD(a: number[]): number {
  let acc = 0, peak = 0, dd = 0;
  for (const x of a) { acc += x; peak = Math.max(peak, acc); dd = Math.max(dd, peak - acc); }
  return dd;
}
// bootstrap CI on a statistic of resampled window sets
function bootstrap(rows: Row[], stat: (r: Row[]) => number, n = 10000): [number, number] {
  const vals: number[] = [];
  for (let i = 0; i < n; i++) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(Math.random() * rows.length)]);
    vals.push(stat(sample));
  }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * n)], vals[Math.floor(0.975 * n)]];
}

function report(rows: Row[], label: string): void {
  if (rows.length < 3) { console.log(`  ${label}: only ${rows.length} windows — need more data\n`); return; }
  const u = rows.map((r) => r.unhedged);
  const hgd = rows.map((r) => r.hedged);
  const cost = rows.reduce((a, r) => a + r.fees + r.slip, 0);
  const dStd = std(u) - std(hgd);
  const dWorst = worst(hgd) - worst(u);
  const dDD = maxDD(u) - maxDD(hgd);
  const [lo, hi] = bootstrap(rows, (rs) => std(rs.map((r) => r.unhedged)) - std(rs.map((r) => r.hedged)));
  const [mlo, mhi] = bootstrap(rows, (rs) => mean(rs.map((r) => r.hedgePnl)));
  console.log(`  ${label} (${rows.length} windows)`);
  console.log(`    mean/window   unhedged $${mean(u).toFixed(1)}  vs hedged $${mean(hgd).toFixed(1)}   (hedge P&L mean $${mean(rows.map((r) => r.hedgePnl)).toFixed(2)}, 95% CI [${mlo.toFixed(2)}, ${mhi.toFixed(2)}])`);
  console.log(`    risk          σ ${std(u).toFixed(1)} → ${std(hgd).toFixed(1)}  (Δσ ${dStd.toFixed(1)}, 95% CI [${lo.toFixed(1)}, ${hi.toFixed(1)}])`);
  console.log(`    worst window  $${worst(u).toFixed(1)} → $${worst(hgd).toFixed(1)}  (Δ ${dWorst.toFixed(1)})`);
  console.log(`    max drawdown  $${maxDD(u).toFixed(1)} → $${maxDD(hgd).toFixed(1)}  (Δ ${dDD.toFixed(1)})`);
  console.log(`    hedge cost    $${cost.toFixed(2)} total (fees+slippage) → risk-removed-per-$ = ${cost > 0 ? (dStd / cost).toFixed(2) : 'n/a'}`);
  console.log(`    VERDICT       ${lo > 0 ? '✅ risk reduction significant at 95%' : dStd > 0 ? '🟡 risk reduced but CI includes 0 — more windows' : '❌ no risk reduction measured'}\n`);
}

// ---------------- main ----------------
const all = load();
const clean = all.filter((r) => !r.excluded);
console.log(`\n=== A/B report · ${all.length} windows logged, ${clean.length} clean (excluded dropped by rule) ===\n`);

// 1) validation arm: hedge OFF → hedge_pnl must be ≈ 0 (counterfactual identity)
const off = clean.filter((r) => r.enabledFrac <= 0.1 && !isNaN(r.hedgePnl));
if (off.length) {
  const noise = off.map((r) => Math.abs(r.hedgePnl));
  console.log(`VALIDATION (${off.length} unhedged windows): |hedge_pnl| mean $${mean(noise).toFixed(2)}, max $${Math.max(...noise).toFixed(2)}`);
  console.log(`  ${Math.max(...noise) < 5 ? '✅ identity holds (≈ equity-noise floor) — paired design is sound' : '⚠️ large hedge_pnl with hedge OFF — investigate leakage before trusting results'}\n`);
}

// 2) treatment arm: hedged windows, paired vs their own counterfactual
const on = clean.filter((r) => r.enabledFrac >= 0.9 && !isNaN(r.hedgePnl));
report(on, 'ALL HEDGED');

// 3) regime split at the median realized vol
if (on.length >= 6) {
  const sorted = [...on].sort((a, b) => a.vol - b.vol);
  const mid = Math.floor(sorted.length / 2);
  report(sorted.slice(0, mid), 'CALM half (below median vol)');
  report(sorted.slice(mid), 'VOLATILE half (above median vol)');
}

// 4) armed-subset (gates open) — pure hedge efficacy
const armed = on.filter((r) => r.armedFrac >= 0.5);
if (armed.length >= 3) report(armed, 'ARMED subset (gates open ≥50% of window)');

console.log(`Pre-registered bar (docs/ab-protocol.md): ≥50 clean hedged windows/regime, Δσ CI > 0, worst-case improved.\n`);
