// Numerically-stable math primitives (CLAUDE.md Q6: float64 + log-sum-exp/softplus).

// log(e^a + e^b) without overflow.
export function logSumExp2(a: number, b: number): number {
  const m = Math.max(a, b);
  if (!isFinite(m)) return m;
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

// softplus(x) = log(1 + e^x), stable for large |x|.
export function softplus(x: number): number {
  if (x > 30) return x; // log(1+e^x) ≈ x
  if (x < -30) return Math.exp(x); // ≈ e^x
  return Math.log1p(Math.exp(x));
}

// logistic sigmoid, stable.
export function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

// standard normal pdf
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// standard normal CDF via Abramowitz & Stegun 7.1.26 (good to ~1e-7).
export function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
