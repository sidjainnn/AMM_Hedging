// Quoting overlay (docs/quoting.md). Turns the engine's inventory-based mid into a
// displayed bid/ask. NEVER mutates inventory q (golden rule #5) — it only
// changes the prices shown/executable. This is the primary internal inventory
// manager; perp hedging is the secondary layer.

import { clamp } from './math';
import type { QuoteParams } from './types';

// Horizon normaliser: 1h tenor (3600 ticks) maps to hatTau≈1.
const REF_TICKS = 3600;

export interface Quote {
  bid: number;
  ask: number;
  reservation: number;
}

// netSkew = qY - qN (house is short YES outcome when positive).
// b = effective liquidity, used to normalise inventory into probability space.
// tenorLabel is optional; when set to '5m' the invWiden5mBoost is applied (the
// 5m market has the sharpest gamma wall, so it earns the extra widening).
export function computeQuote(
  pEngine: number,
  netSkew: number,
  b: number,
  tauTicks: number,
  qp: QuoteParams,
  tenorLabel?: string
): Quote {
  if (qp.mode === 'manual') {
    const s = qp.manualHalfSpread;
    return {
      reservation: pEngine,
      bid: clamp(pEngine - s, 1e-4, 1 - 1e-4),
      ask: clamp(pEngine + s, 1e-4, 1 - 1e-4),
    };
  }

  // Avellaneda–Stoikov, mapped into probability space. Raw τ is in ticks
  // (hundreds–thousands) and the AS terms are in price units, so we normalise
  // the horizon to ~[0,1] (REF_TICKS = 1h) to keep the spread in sane cents.
  // Inventory in YES-equivalent units is -(qY-qN): the house being short the
  // YES outcome (netSkew>0) pulls reservation UP to discourage more YES buys.
  const hatTau = Math.max(tauTicks, 1) / REF_TICKS;
  const invNorm = netSkew / Math.max(b, 1e-9);
  const reservation = clamp(
    pEngine + invNorm * qp.gamma * qp.sigma * qp.sigma * hatTau,
    1e-4,
    1 - 1e-4
  );
  // Gamma / pin-risk term. A binary's adverse-selection cost EXPLODES as τ→0
  // around the strike (digital gamma → ∞), and a linear perp can't hedge it, so
  // the spread must charge for it. p(1−p) peaks ATM (max outcome uncertainty),
  // and /√τ̂ makes the charge surge into expiry — the opposite of the Stoikov
  // time term, which collapses to its floor exactly when toxicity is worst.
  const pinRisk = (qp.gammaWiden ?? 0) * pEngine * (1 - pEngine) / Math.sqrt(hatTau);
  // Inventory-proportional widening: half-spread grows with |netSkew|/b. 0 at
  // flat inventory (keeps quotes competitive — liquidity keeps flowing); grows
  // as the house accumulates one-sided inventory, paying users to close the gap
  // before it becomes risky. The 5m market gets a configurable boost (its
  // gamma wall is the sharpest of the three tenors, so early widening earns
  // the most). The boost is the *only* thing that makes this tenor-specific;
  // all three tenors read from one QuoteParams object.
  const boost = tenorLabel === '5m' ? (qp.invWiden5mBoost ?? 1) : 1;
  const invWidenTerm = (qp.invWiden ?? 0) * Math.abs(invNorm) * boost;
  // spread = γσ²(T−t) + (2/γ)·ln(1+γ/k) + pin-risk + invWiden
  const spread =
    qp.gamma * qp.sigma * qp.sigma * hatTau +
    (2 / qp.gamma) * Math.log(1 + qp.gamma / qp.k) +
    pinRisk +
    invWidenTerm;
  const half = clamp(spread / 2, 1e-4, 0.15);
  return {
    reservation,
    bid: clamp(reservation - half, 1e-4, 1 - 1e-4),
    ask: clamp(reservation + half, 1e-4, 1 - 1e-4),
  };
}
