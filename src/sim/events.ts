// Digital (binary) event model: P( BTC(t+τ) > K ) under GBM, drift 0.
// Used in two epistemically-separate places:
//   - arbitrageurs & Book C   -> ESTIMATED sigma (deployment-available)
//   - true-delta Books A/B     -> TRUE sigma     (sim-ground-truth, golden rule #6)
// sigma here is per-tick vol; tau is in ticks, so sigma*sqrt(tau) is the
// horizon stdev of log-returns. Keeps everything in the sim's native time unit.

import { normCdf, normPdf, clamp } from './math';

export interface DigitalQuote {
  p: number; // P(event = BTC > K)
  dpdS: number; // sensitivity of p to spot (digital delta)
}

// p = Phi(d), d = (ln(S/K) - 0.5 σ²τ) / (σ√τ)
export function digitalProb(
  spot: number,
  strike: number,
  sigmaPerTick: number,
  tauTicks: number
): DigitalQuote {
  const tau = Math.max(tauTicks, 1e-9);
  const vol = Math.max(sigmaPerTick, 1e-12);
  const denom = vol * Math.sqrt(tau);
  const d = (Math.log(spot / strike) - 0.5 * vol * vol * tau) / denom;
  const p = clamp(normCdf(d), 1e-6, 1 - 1e-6);
  // dp/dS for a digital: phi(d) * d(d)/dS = phi(d) / (S * σ√τ)
  const dpdS = normPdf(d) / (spot * denom);
  return { p, dpdS };
}
