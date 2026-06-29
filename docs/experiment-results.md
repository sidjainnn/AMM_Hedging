# Experiment: hedging the AMM liquidity skew on perps (5×5-min markets)

**Question.** An AMM market maker is a *principal* — it warehouses the inventory
(liquidity) skew the crowd creates, so its P&L is exposed to BTC direction in a
way a CLOB (agency) never is. Can we hedge that skew on Binance perps, and which
hedge — **delta**, **sentiment**, or **combined** — works best?

## Setup
- **Agents:** the human-like `behavioral` population (sporadic Poisson arrivals,
  heavy-tailed sizes, noise/momentum/contrarian/informed archetypes, finite
  wallets). Run with strong directional flow so a real one-sided skew builds.
- **Markets:** 5 full 5-minute markets (1500 ticks @ 1 tick/s).
- **Price:** real Binance BTC 1-minute closes (live fetch), interpolated to 1s.
- **Budget:** full **$10,000** notional, no per-position cap.
- **Hedges (perp overlays on the *same* flow):**
  - `delta` — hold perp = aggregate settlement-value δ (neutralise the skew)
  - `sentiment` — hold perp ∝ skill-weighted smart-money lean
  - `combined` — delta hedge + a 50%-cap sentiment tilt
  - `none` — unhedged AMM (baseline)

## Method — why a BTC-outcome stress
Within one path the directional P&L is buried under spread-capture + settlement
noise, so a single run can't isolate it (and a linear β is meaningless because
the unhedged book is **short-gamma / convex** — it loses on *big moves in either
direction*). So we **stress the same 5-market flow across BTC outcomes**
(−3%…+3% terminal, real intraday wiggles kept) and measure the **dispersion of
final P&L across outcomes** and the **worst case**. Averaged over 11 real base
windows.

## Results

Example sweep (one window) — final net P&L by BTC outcome (the unhedged
short-gamma hump is the skew risk):

| BTC move | none | delta | sentiment | combined |
|---|---:|---:|---:|---:|
| −3% | −$76 | $161 | $74 | $184 |
| −1% | $260 | $305 | $266 | $309 |
| 0%  | $346 | $331 | $338 | $328 |
| +1% | $198 | $265 | $222 | $272 |
| +3% | −$95 | $129 | $38 | $168 |

Risk across BTC outcomes, **averaged over 11 real windows**:

| strategy | P&L dispersion (σ) | worst-case | dispersion removed |
|---|---:|---:|---:|
| **none** | $200 | **−$115** | — |
| **delta** | $135 | +$85 | **33% lower** |
| **sentiment** | $156 | +$9 | 22% lower |
| **combined** | **$126** | **+$109** | **37% lower** |

## Findings
1. **Hedging the skew works.** Delta/combined remove **~33–37%** of the P&L
   dispersion across BTC outcomes and turn the **worst case from −$115 to
   +$85/+$109** — i.e. they convert the AMM's directional/short-gamma loss (the
   risk a CLOB doesn't carry) into a flat, reliably-positive P&L.
2. **Combined is best**, then delta, then sentiment. Pure **sentiment is the
   weakest hedge** (a noisy directional proxy), but as a *tilt on top of delta*
   it improved both dispersion and the worst case — delta does the hedging,
   sentiment adds a small edge.
3. **The residual ~$126 dispersion is NOT directional** — it's spread-capture
   lumpiness + adverse selection, which perps can't (and shouldn't) hedge. Only
   the vig/spread pays for that. This is exactly the AMM-vs-CLOB split: perps
   neutralise the *inventory direction*; the *adverse-selection subsidy* is a
   separate cost.

## Caveats (honest)
- Demo/paper + simulation: real fills assume ≈mark; **slippage & stochastic
  funding are not yet modelled** (they'd raise hedge cost, esp. in stress).
- The **sentiment** signal comes from *simulated* agents inferring from the same
  price — it has no genuine forward edge yet, so its standalone value is
  understated/noisy. Real edge needs the deferred work in
  [agents-implementation.md](agents-implementation.md).
- Numbers move window-to-window; the headline is the **direction & magnitude
  averaged over 11 windows**, not any single figure.

## Reproduce / run live
- Sim: `npx esbuild src/sim/experiment.ts --bundle --platform=node --format=esm --outfile=/tmp/exp.mjs && node /tmp/exp.mjs`
- Live paper: backend `HEDGE_MODE=combined` (or `delta`/`sentiment`), sized to
  `MAX_NOTIONAL_USDT=10000`; toggle modes on the **Live (demo)** tab and watch
  the account-equity curve. See [STATUS.md](STATUS.md).
