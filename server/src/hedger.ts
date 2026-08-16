import { config } from './config';
import { getPositionUnits, getFilters, marketOrder, type OrderResult } from './binance';

// Reconciles the live DEMO futures position to the sim's Book-C delta target
// (Book C = the deployment-realistic book: estimated σ, no ground-truth leak).
// Gated three ways: runtime `enabled`, DRY_RUN, and a hard position cap.

export interface HedgeAction {
  ts: number;
  targetUnits: number;
  positionUnits: number;
  order: OrderResult | null;
  note: string;
}

// Binance USDⓈ-M futures taker fee ≈ 0.04% = 4 bps. Demo fills don't always
// report the fee, so we estimate it from filled notional for the P&L card.
const TAKER_BPS = 4;

export class Hedger {
  enabled = config.hedgeEnabled;
  livePosition = 0;
  lastError: string | null = null;
  log: HedgeAction[] = [];
  feesPaid = 0; // cumulative estimated taker fees (USDT), for the per-window card
  // cumulative fill stats for the A/B window ledger
  fillCount = 0;
  notionalTraded = 0; // Σ |qty|·mark (USDT)
  slippagePaid = 0; // Σ (fill − mark)·signedQty — + = paid worse than decision mark
  // Hedge P&L tracked HERE (avg-entry + realized), independent of the coarse 10s
  // account refresh, so per-window attribution is exact at the boundary tick.
  private avgEntry = 0;
  private realizedHedge = 0;

  // realized + unrealized hedge P&L marked at `mark` — the ledger diffs this per
  // window instead of using account-equity deltas (which smear across boundaries).
  hedgePnl(mark: number): number {
    return this.realizedHedge + this.livePosition * (mark - this.avgEntry);
  }

  // update avg-entry / realized on a fill (posBefore = position before the fill).
  private applyFillPnl(posBefore: number, signedFill: number, price: number): void {
    const newPos = posBefore + signedFill;
    if (posBefore === 0 || Math.sign(signedFill) === Math.sign(posBefore)) {
      this.avgEntry = newPos !== 0 ? (posBefore * this.avgEntry + signedFill * price) / newPos : 0;
    } else {
      const closed = Math.min(Math.abs(signedFill), Math.abs(posBefore));
      this.realizedHedge += Math.sign(posBefore) * closed * (price - this.avgEntry);
      if (Math.abs(signedFill) > Math.abs(posBefore)) this.avgEntry = price; // flipped
      else if (newPos === 0) this.avgEntry = 0;
    }
  }

  async refreshPosition(): Promise<void> {
    if (!config.hasKeys()) return;
    try {
      this.livePosition = await getPositionUnits();
      this.lastError = null;
    } catch (e) {
      this.lastError = String(e);
    }
  }

  async reconcile(targetUnits: number, markPrice: number): Promise<void> {
    if (!this.enabled || !config.hasKeys()) return;
    // clamp to the notional budget (≈ the whole 10k): cap = maxNotional / price
    const cap = config.maxNotionalUsdt / markPrice;
    await this.moveTo(Math.max(-cap, Math.min(cap, targetUnits)), markPrice, 'order sent');
  }

  // Close the live position to zero — used when hedging is turned OFF so the
  // kill switch leaves no open perp exposure. Runs regardless of `enabled`.
  // force=true bypasses the rebalance deadband (we always want to reach flat).
  async flatten(markPrice: number): Promise<void> {
    if (!config.hasKeys()) return;
    await this.moveTo(0, markPrice, 'flatten (hedge OFF)', true);
  }

  private async moveTo(target: number, markPrice: number, note: string, force = false): Promise<void> {
    try {
      const f = await getFilters();
      this.livePosition = await getPositionUnits();
      const posBefore = this.livePosition; // for hedge-P&L tracking
      const diff = target - this.livePosition;
      // Is this trade REDUCING exposure (moving toward / to zero, same side)?
      // Binance allows sub-$50 orders only when reduceOnly — and reduceOnly also
      // guarantees we never accidentally flip the sign.
      const reducing = this.livePosition !== 0 &&
        (target === 0 ||
          (Math.sign(target) === Math.sign(this.livePosition) && Math.abs(target) < Math.abs(this.livePosition)));
      const notionalDiff = Math.abs(diff) * markPrice;
      // Rebalance deadband: skip tiny target wobbles that would only churn fees.
      // Bypassed when force=true (flatten) so we can always reach zero.
      if (!force && notionalDiff < config.hedgeDeadbandUsdt) return;
      if (Math.abs(diff) < f.minQty) return; // below exchange lot size
      // Non-reduce (opening/adding) orders must clear the $50 min-notional;
      // reduce orders are exempt (that's the −4164 fix for closing dust).
      if (!reducing && notionalDiff < f.minNotional) return;
      const order = await marketOrder(diff > 0 ? 'BUY' : 'SELL', diff, reducing);
      // estimate the taker fee on the filled notional (both real & dry-run so
      // the per-window P&L card has a fee figure to show)
      this.feesPaid += Math.abs(order.qty || diff) * markPrice * (TAKER_BPS / 1e4);
      if (order.qty > 0) {
        this.fillCount++;
        this.notionalTraded += order.qty * markPrice;
        const fillPrice = order.avgPrice > 0 ? order.avgPrice : markPrice;
        if (order.avgPrice > 0) {
          // signed slippage: + = the fill was worse than the decision mark
          const signed = order.side === 'BUY' ? 1 : -1;
          this.slippagePaid += (fillPrice - markPrice) * signed * order.qty;
        }
        // update realized/avg-entry from the actual fill (posBefore → after)
        this.applyFillPnl(posBefore, order.side === 'BUY' ? order.qty : -order.qty, fillPrice);
      }
      if (order.qty > 0 && !order.dryRun) {
        this.livePosition = await getPositionUnits();
      } else if (order.dryRun) {
        this.livePosition += order.side === 'BUY' ? order.qty : -order.qty; // simulate
      }
      this.push({ ts: Date.now(), targetUnits: target, positionUnits: this.livePosition, order,
        note: order.dryRun ? 'dry-run (no order sent)' : note });
      this.lastError = null;
    } catch (e) {
      this.lastError = String(e);
      this.push({ ts: Date.now(), targetUnits: target, positionUnits: this.livePosition, order: null, note: 'ERROR: ' + e });
    }
  }

  private push(a: HedgeAction): void {
    this.log.unshift(a);
    if (this.log.length > 50) this.log.pop();
  }
}
