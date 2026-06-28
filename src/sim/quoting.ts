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
export function computeQuote(
  pEngine: number,
  netSkew: number,
  b: number,
  tauTicks: number,
  qp: QuoteParams
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
  // spread = γσ²(T−t) + (2/γ)·ln(1+γ/k), with normalised horizon.
  const spread =
    qp.gamma * qp.sigma * qp.sigma * hatTau +
    (2 / qp.gamma) * Math.log(1 + qp.gamma / qp.k);
  const half = clamp(spread / 2, 1e-4, 0.15);
  return {
    reservation,
    bid: clamp(reservation - half, 1e-4, 1 - 1e-4),
    ask: clamp(reservation + half, 1e-4, 1 - 1e-4),
  };
}
