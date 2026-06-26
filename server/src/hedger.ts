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

export class Hedger {
  enabled = config.hedgeEnabled;
  livePosition = 0;
  lastError: string | null = null;
  log: HedgeAction[] = [];

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
    try {
      const f = await getFilters();
      // clamp the target to the safety cap
      let target = Math.max(-config.maxPositionBtc, Math.min(config.maxPositionBtc, targetUnits));
      this.livePosition = await getPositionUnits();
      const diff = target - this.livePosition;
      if (Math.abs(diff) * markPrice < f.minNotional || Math.abs(diff) < f.minQty) {
        return; // too small to trade
      }
      const order = await marketOrder(diff > 0 ? 'BUY' : 'SELL', diff);
      if (order.qty > 0 && !order.dryRun) {
        this.livePosition = await getPositionUnits();
      } else if (order.dryRun) {
        this.livePosition += order.side === 'BUY' ? order.qty : -order.qty; // simulate
      }
      this.push({ ts: Date.now(), targetUnits: target, positionUnits: this.livePosition, order,
        note: order.dryRun ? 'dry-run (no order sent)' : 'order sent' });
      this.lastError = null;
    } catch (e) {
      this.lastError = String(e);
      this.push({ ts: Date.now(), targetUnits, positionUnits: this.livePosition, order: null, note: 'ERROR: ' + e });
    }
  }

  private push(a: HedgeAction): void {
    this.log.unshift(a);
    if (this.log.length > 50) this.log.pop();
  }
}
