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
  async flatten(markPrice: number): Promise<void> {
    if (!config.hasKeys()) return;
    await this.moveTo(0, markPrice, 'flatten (hedge OFF)');
  }

  private async moveTo(target: number, markPrice: number, note: string): Promise<void> {
    try {
      const f = await getFilters();
      this.livePosition = await getPositionUnits();
      const diff = target - this.livePosition;
      if (Math.abs(diff) * markPrice < f.minNotional || Math.abs(diff) < f.minQty) {
        return; // too small to trade (or already flat)
      }
      const order = await marketOrder(diff > 0 ? 'BUY' : 'SELL', diff);
      // estimate the taker fee on the filled notional (both real & dry-run so
      // the per-window P&L card has a fee figure to show)
      this.feesPaid += Math.abs(order.qty || diff) * markPrice * (TAKER_BPS / 1e4);
      if (order.qty > 0) {
        this.fillCount++;
        this.notionalTraded += order.qty * markPrice;
        if (order.avgPrice > 0) {
          // signed slippage: + = the fill was worse than the decision mark
          const signed = order.side === 'BUY' ? 1 : -1;
          this.slippagePaid += (order.avgPrice - markPrice) * signed * order.qty;
        }
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
