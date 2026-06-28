// Pricing engines (docs/engines.md). Inventory-priced AMM: price is a function
// of inventory q only — NOT anchored to the Binance feed (golden rule #1; the
// feed is the underlying source of truth, not a quote input). Trades vs the
// engine are BUYS of YES or
// NO shares — a user "selling YES" is modelled as buying NO (binary AMM
// convention). This keeps one uniform interface across all three engines.
//
// House inventory: qY/qN = shares the house is SHORT (it sold them to users).
// At settlement the house pays qY if YES wins, else qN.

import { logSumExp2, sigmoid } from '../math';
import type { EngineKind, EngineParams, Side } from '../types';

export interface Engine {
  readonly kind: EngineKind;
  qY: number;
  qN: number;
  pYes(): number;
  effectiveB(): number;
  // cash the house RECEIVES for selling `shares` of `side` (no state change)
  quoteBuy(side: Side, shares: number): number;
  // execute: mutate inventory, return cash received
  applyBuy(side: Side, shares: number): number;
  // liability owed at settlement given outcome
  settlementLiability(outcomeYes: boolean): number;
}

// ---------- LMSR (primary) ----------
class LMSR implements Engine {
  readonly kind: EngineKind = 'LMSR';
  qY = 0;
  qN = 0;
  constructor(private b: number) {}
  private cost(qY: number, qN: number): number {
    return this.b * logSumExp2(qY / this.b, qN / this.b);
  }
  pYes(): number {
    return sigmoid((this.qY - this.qN) / this.b);
  }
  effectiveB(): number {
    return this.b;
  }
  quoteBuy(side: Side, shares: number): number {
    const c0 = this.cost(this.qY, this.qN);
    const c1 =
      side === 'YES'
        ? this.cost(this.qY + shares, this.qN)
        : this.cost(this.qY, this.qN + shares);
    return c1 - c0;
  }
  applyBuy(side: Side, shares: number): number {
    const cash = this.quoteBuy(side, shares);
    if (side === 'YES') this.qY += shares;
    else this.qN += shares;
    return cash;
  }
  settlementLiability(outcomeYes: boolean): number {
    return outcomeYes ? this.qY : this.qN;
  }
}

// ---------- LS-LMSR (adaptive) ----------
// b(Q) = b0 + alpha*Q with Q = qY+qN. Cost is charged as C(after;b_after) -
// C(before;b_before); the state-dependent b creates the built-in vig and makes
// the market tight when thin / stable when mature (docs/engines.md).
class LSLMSR implements Engine {
  readonly kind: EngineKind = 'LS-LMSR';
  qY = 0;
  qN = 0;
  constructor(private b0: number, private alpha: number) {}
  private bOf(qY: number, qN: number): number {
    return this.b0 + this.alpha * (qY + qN);
  }
  private cost(qY: number, qN: number): number {
    const b = this.bOf(qY, qN);
    return b * logSumExp2(qY / b, qN / b);
  }
  pYes(): number {
    const b = this.bOf(this.qY, this.qN);
    return sigmoid((this.qY - this.qN) / b);
  }
  effectiveB(): number {
    return this.bOf(this.qY, this.qN);
  }
  quoteBuy(side: Side, shares: number): number {
    const c0 = this.cost(this.qY, this.qN);
    const c1 =
      side === 'YES'
        ? this.cost(this.qY + shares, this.qN)
        : this.cost(this.qY, this.qN + shares);
    return c1 - c0;
  }
  applyBuy(side: Side, shares: number): number {
    const cash = this.quoteBuy(side, shares);
    if (side === 'YES') this.qY += shares;
    else this.qN += shares;
    return cash;
  }
  settlementLiability(outcomeYes: boolean): number {
    return outcomeYes ? this.qY : this.qN;
  }
}

// ---------- CPMM (benchmark) ----------
// Manifold-style constant-product. reserves y/n, invariant y*n=k, P(YES)=n/(y+n).
// Buying `shares` of YES: solve cash M from M²+(y+n-s)M - s·n = 0, then
// y' = y+M-s, n' = n+M. The losing token decays toward 0 at settlement (the
// documented CPMM flaw). qY/qN track shares sold for settlement accounting.
class CPMM implements Engine {
  readonly kind: EngineKind = 'CPMM';
  qY = 0;
  qN = 0;
  private y: number;
  private n: number;
  constructor(seed: number) {
    this.y = seed;
    this.n = seed;
  }
  pYes(): number {
    return this.n / (this.y + this.n);
  }
  effectiveB(): number {
    // depth proxy comparable to LMSR's b
    return (this.y + this.n) / 4;
  }
  private solveCash(reserveOut: number, reserveOther: number, shares: number) {
    // M for buying `shares` out of reserveOut pool
    const a = 1;
    const b = reserveOut + reserveOther - shares;
    const c = -shares * reserveOther;
    return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  }
  quoteBuy(side: Side, shares: number): number {
    return side === 'YES'
      ? this.solveCash(this.y, this.n, shares)
      : this.solveCash(this.n, this.y, shares);
  }
  applyBuy(side: Side, shares: number): number {
    if (side === 'YES') {
      const M = this.solveCash(this.y, this.n, shares);
      this.y = this.y + M - shares;
      this.n = this.n + M;
      this.qY += shares;
      return M;
    } else {
      const M = this.solveCash(this.n, this.y, shares);
      this.n = this.n + M - shares;
      this.y = this.y + M;
      this.qN += shares;
      return M;
    }
  }
  settlementLiability(outcomeYes: boolean): number {
    return outcomeYes ? this.qY : this.qN;
  }
}

export function makeEngine(p: EngineParams): Engine {
  switch (p.kind) {
    case 'LMSR':
      return new LMSR(p.b0);
    case 'LS-LMSR':
      return new LSLMSR(p.b0, p.alpha);
    case 'CPMM':
      return new CPMM(p.cpmmK ?? p.b0);
  }
}
