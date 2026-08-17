> Engineering notes carried over from working sessions. Findings, root
> causes and decisions recorded as they were made — kept because the
> reasoning behind a fix is usually harder to recover than the fix.

The fundamental P&L identity for the inventory-priced AMM maker in [[amm-hedging-project]]:

**net = spread capture − (LMSR subsidy + adverse selection) + hedge P&L − fees − funding**

- The **inventory loss is structural**: every market that resolves decisively
  costs the house ≈ `b·ln2` (LMSR bounded loss) — the subsidy paid for inventory-based
  price discovery. Confirmed numerically: inv loss ≈ Σ b·ln2 over settled
  cohorts. It does NOT shrink with noise (noise is symmetric, ~zero net price
  displacement).
- **Spread capture is the only revenue.** Noise = symmetric churn that pays
  spread "for free" (no displacement). Directional/arb = displacement = subsidy +
  adverse selection (the cost).
- **Break-even condition: vig (spread) must out-earn b·ln2 per market + adverse
  selection.** Break-even half-spread ≈ ln2 / (volume-per-market / b), roughly
  scale-invariant in b (volume scales with b too) — so the real lever is the
  noise:toxic churn ratio and the spread width, not b alone.

The original default (b150, Stoikov k60 → ~1.7¢ half-spread, balanced agent mix)
LOST ~17k/8000 ticks because spread (~6k) covered only ~25% of the subsidy
(~24k). Break-even acceptance is measured on the **5-minute setup** via
`src/sim/breakeven.ts` (64 windows, delta hedge on, decomposed). Live default is
**b110, Stoikov k=12**. k sweep: k=25 → +$16/window (66%); k=12 → +$71 (95%);
k=9 → +$97 (97%).

**Expiry gamma wall (key):** a 5-min binary is short-gamma — near expiry
`dp/dS` blows up at the strike and a LINEAR perp can't hedge γ (the σ√τ trigger
also flattens it). The loss is adverse selection at the pin, worsened by the
Stoikov spread collapsing to its floor as τ→0. Fixed in quoting/risk, NOT
hedging: (1) pin-risk spread widening `quote.gammaWiden` (default 0.03, term
∝ p(1−p)/√τ̂) lifts the mean; (2) final-30s reduce-only lockout
`expiryLockoutTicks` (default 30) refuses inventory-increasing engine trades at
the wall, crushing the tail. A/B at k=12: off → $50.7/window, 78%, worst −$74,
std 84; gamma-wall both → $71.5, 95%, worst −$56, std 54 (−36% variance).

**5m profit optimization (on top of the gamma-wall fix, sim-frozen then live):**
three levers in `breakeven.ts` — (1) inventory-proportional spread widening
`quote.invWiden` (0.015, +50% boost on 5m via `invWiden5mBoost`): half-spread ∝
|netSkew|/b, 0 at flat so quotes stay competitive; (2) risk-tier hedge dial
`hedgeNotionalUsdt`/`riskTierLow/High` (200/0.3/0.7): Books A/C use 0/0.3/0.7/1.0
as notional exposure rises, killing fee churn when flat; (3) per-tenor expiry
lockout `expiryLockoutTicks5m`=60 (vs 30). FULL A/B: $77.9/window, 97%, worst
−$43, std 49 (PASS mean≥50/rate≥90/worst≥−80/std≤80). Regime: calm $82/98%, storm
$92/98%. The LIVE runner gates the demo hedge on BOTH vol gate AND inventory gate
(reads sim `idleReason`/`notionalUsdt`); env `HEDGE_NOTIONAL_USDT`/`HEDGE_TIER_*`
override for live recalibration. Hedging mainly reduces directional VARIANCE; it
cannot recover the subsidy or terminal gamma (guaranteed costs paid by the vig).

**How to apply:** if asked why it loses, check spread-capture vs inventory in the
Page-2 component decomposition. To restore profit: widen spread (lower Stoikov k
or manual half-spread) and/or raise noise relative to directional+arb.
