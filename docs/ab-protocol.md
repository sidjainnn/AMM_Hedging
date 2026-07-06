# A/B protocol — does hedging the AMM skew pay for itself? (pre-registered)

Written BEFORE the run. The metric, sample size, and exclusion rules below are
fixed; changing them after seeing data invalidates the result.

## Question
On the live BTC feed with real demo perp orders, does delta-hedging the 5m
book's inventory skew remove more risk than it costs (fees + slippage + basis)?

## Design — paired, within-window
The hedge never feeds back into the book (agents/quotes don't see the perp), so
every hedged window carries its own exact unhedged counterfactual:

```
unhedged_net = vig + inventory          (the book alone)
hedged_net   = unhedged_net + hedge_pnl (hedge_pnl = real account equity Δ)
```

This removes market-regime noise entirely (same window, same flow, same BTC
path in both arms). **Validation arm:** scheduled unhedged windows check the
identity — their `hedge_pnl` must sit at the equity-noise floor (< ~$5). If it
doesn't, there is leakage and the design is void.

## Execution
- **Scheduler:** `▶ Start A/B run` (Live tab) — alternates `AB_BLOCKS_ON=6`
  hedged + `AB_BLOCKS_OFF=2` validation windows at each 5m roll. The ON→OFF
  flatten fires one tick before the roll so transition costs land in the hedged
  arm. Manual hedge toggles stop the schedule.
- **Instrument:** `server/data/ledger.csv` (one row per settled window; real
  fills via `avgPrice`, measured slippage, estimated fees, equity snapshots).
- **Coverage:** run on ≥2 different days, at least one including a
  high-volatility session (e.g. US data release). Backend must stay up;
  restarts are fine (rows persist; boot windows auto-excluded).

## Sample size
≥ **50 clean hedged windows per regime half** (calm/volatile median split).
Preliminary reads allowed after ~20 but are not the result.

## Exclusion rules (mechanical, pre-registered)
A window is excluded iff `excluded=1` in the ledger: it was the boot window
(`partial=1`) or had ≥1 stale-feed tick. Mixed windows (0.1 < enabled_frac
< 0.9, i.e. schedule started/stopped mid-window) are dropped by the analysis.

## Primary metric
**Risk removed per dollar of cost** on hedged windows:
- Δσ = σ(unhedged_net) − σ(hedged_net) with 10k-resample bootstrap 95% CI
- Δworst-case and Δmax-drawdown (supporting)
- cost = Σ(fees + slippage)
Mean P&L is explicitly NOT the success criterion (hedged mean is expected to be
slightly lower — that's the insurance premium).

## Success criteria
1. Validation: max |hedge_pnl| in unhedged windows < $5.
2. Δσ bootstrap 95% CI strictly above 0 in the volatile half (the regime the
   hedge exists for).
3. Worst-case window improved (Δworst > 0) overall.
4. Calm half: Δσ may be ≈ 0 with small negative mean (fee drag) — acceptable if
   the armed-fraction there is low (the gate is doing its job).

## Analysis
```bash
cd server && npx tsx src/abreport.ts
```
Reports validation, paired stats + CIs, calm/volatile split, armed subset.

## Known limitations (stated up front)
- The book is paper (simulated agents on the real feed); only the hedge leg is
  real. This experiment prices the hedge, not the flow.
- Demo-venue fills may understate production slippage at scale.
- Fees are estimated at 4 bps taker (venue commission not itemized per fill).
- Account equity includes funding and mark noise (~±$1/window floor).
