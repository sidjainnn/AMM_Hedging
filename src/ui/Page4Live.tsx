import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

import { useLiveBackend } from './useLiveBackend';
import { fmt, usd, usd2, cls } from './format';

export function Page4Live() {
  const { state, connected, setHedge, backend } = useLiveBackend(true);

  if (!state) {
    return (
      <div className="panel" style={{ textAlign: 'center', padding: 48 }}>
        <h3>Connecting to live backend…</h3>
        <p className="hint" style={{ marginTop: 10 }}>
          Expecting the server at <b>{backend}</b>. If it isn't running:
        </p>

        <pre
          style={{
            textAlign: 'left',
            display: 'inline-block',
            background: 'var(--panel-2)',
            padding: 12,
            borderRadius: 8,
            marginTop: 8,
          }}
        >
{`cd server
cp .env.example .env   # add your Binance demo keys
npm install
npm start`}
        </pre>
      </div>
    );
  }

  const L = state.live;

  const priceData = state.btcSeries.map((p) => ({
    t: p.tick,
    btc: p.btc,
  }));

  return (
    <div className="col">
      {/* LIVE STATUS STRIP */}
      <div className="panel">
        <h3>
          Live demo trading{' '}
          <span className="hint">
            server-side sim driven by Binance feed · spot UI / futures hedging
          </span>

          <span style={{ float: 'right', display: 'flex', gap: 8 }}>
            <span className={`tag ${connected ? 'deploy' : 'sim'}`}>
              {connected ? 'connected' : 'reconnecting'}
            </span>
            <span className={`tag ${L.dryRun ? 'sim' : 'deploy'}`}>
              {L.dryRun ? 'DRY-RUN' : 'LIVE ORDERS'}
            </span>
          </span>
        </h3>

        <div className="strip">
          {/* SPOT PRICE (USER VIEW) */}
          <div className="cell">
            <div className="lbl">{L.symbol} spot</div>
            <div className="val">${fmt(L.spotPrice, 1)}</div>
            <div className="hint">binance spot feed</div>
          </div>

          {/* FUTURES MARK PRICE (ENGINE) */}
          <div className="cell">
            <div className="lbl">futures mark</div>
            <div className="val">${fmt(L.futuresMarkPrice, 1)}</div>
            <div className="hint">hedging + pnl engine</div>
          </div>

          <div className="cell">
            <div className="lbl">venue</div>
            <div className="val" style={{ fontSize: 12 }}>
              {L.venue.replace('https://', '')}
            </div>
            <div className="hint">demo / paper</div>
          </div>

          <div className="cell">
            <div className="lbl">est σ /tick</div>
            <div className="val">{fmt(state.estSigma * 100, 4)}%</div>
            <div className="hint">realised, deployable</div>
          </div>

          <div className="cell">
            <div className="lbl">API keys</div>
            <div className="val">{L.hasKeys ? 'loaded' : 'none'}</div>
            <div className="hint">
              {L.hasKeys ? 'in server .env' : 'add to .env'}
            </div>
          </div>

          <div className="cell">
            <div className="lbl">sim tick</div>
            <div className="val">{state.tick}</div>
            <div className="hint">1/sec real-time</div>
          </div>
        </div>
      </div>

      {/* CHART */}
      <div className="row">
        <div className="panel" style={{ flex: 2, minWidth: 420 }}>
          <h3>{L.symbol} spot price</h3>

          <ResponsiveContainer width="100%" height={220}>
            <LineChart
              data={priceData}
              margin={{ top: 5, right: 10, left: 0, bottom: 0 }}
            >
              <XAxis
                dataKey="t"
                tick={{ fill: '#8a93a6', fontSize: 10 }}
                stroke="#232a3b"
              />
              <YAxis
                domain={['auto', 'auto']}
                tick={{ fill: '#8a93a6', fontSize: 10 }}
                stroke="#232a3b"
                width={58}
                tickFormatter={(v) => (v / 1000).toFixed(1) + 'k'}
              />
              <Tooltip
                contentStyle={{
                  background: '#131722',
                  border: '1px solid #232a3b',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: '#8a93a6' }}
                formatter={(v) => ['$' + fmt(Number(v), 1), 'BTC']}
              />

              <Line
                type="monotone"
                dataKey="btc"
                stroke="var(--sim)"
                dot={false}
                strokeWidth={1.6}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* MARKETS */}
        <div className="panel" style={{ flex: 1, minWidth: 280 }}>
          <h3>
            Markets <span className="hint">{state.markets.length} live</span>
          </h3>

          <table>
            <thead>
              <tr>
                <th>tenor</th>
                <th>strike</th>
                <th>P(YES)</th>
                <th>skew</th>
              </tr>
            </thead>

            <tbody>
              {state.markets.map((m) => (
                <tr key={m.id}>
                  <td>{m.tenorLabel}</td>
                  <td className="mut">{fmt(m.strike, 0)}</td>
                  <td>{fmt(m.pYes, 3)}</td>
                  <td className={cls(m.netSkew)}>{fmt(m.netSkew, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* HEDGE CONTROL */}
      <div className="panel">
        <h3>
          Demo futures hedge{' '}
          <span className="hint">
            Book C target (deployment-realistic)
          </span>
        </h3>

        <div className="strip" style={{ marginBottom: 12 }}>
          <div className="cell">
            <div className="lbl">live position</div>
            <div className="val">{fmt(L.livePosition, 4)} BTC</div>
            <div className="hint">on {L.symbol}</div>
          </div>

          <div className="cell">
            <div className="lbl">Book C target</div>
            <div className="val">
              {fmt(
                state.books.find((b) => b.id === 'C')?.targetUnits ?? 0,
                4
              )}
            </div>
            <div className="hint">delta to hold</div>
          </div>

          <div className="cell">
            <div className="lbl">position cap</div>
            <div className="val">±{fmt(L.maxPositionBtc, 3)}</div>
            <div className="hint">hard limit</div>
          </div>

          <div className="cell">
            <div className="lbl">hedging</div>
            <div className="val">
              <button
                className={'btn ' + (L.hedgeEnabled ? 'danger' : 'primary')}
                onClick={() => setHedge(!L.hedgeEnabled)}
              >
                {L.hedgeEnabled ? '■ Stop' : '▶ Enable'}
              </button>
            </div>
            <div className="hint">
              {L.dryRun ? 'dry-run: logs only' : 'sends demo orders'}
            </div>
          </div>
        </div>

        {L.hedgeError && (
          <p className="neg" style={{ fontSize: 12 }}>
            hedge error: {L.hedgeError}
          </p>
        )}

        {!L.hasKeys && (
          <p className="hint">
            Add Binance demo keys to <b>server/.env</b>
          </p>
        )}

        <h3 style={{ marginTop: 8 }}>Hedge activity</h3>

        <div className="tape">
          {L.hedgeLog.length === 0 && (
            <div className="mut">no hedge actions yet</div>
          )}

          {L.hedgeLog.map((h, i) => (
            <div className="line" key={i}>
              <span className={h.order?.side === 'BUY' ? 'pos' : 'neg'}>
                {h.order
                  ? `${h.order.side} ${fmt(h.order.qty, 4)} BTC`
                  : '—'}
              </span>

              <span className="mut">
                target {fmt(h.targetUnits, 4)} · pos {fmt(h.positionUnits, 4)} · {h.note}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* PNL CARDS */}
      <div className="cards3">
        {state.books.map((b) => (
          <div className={`bookcard ${b.id}`} key={b.id}>
            <h4>{b.label}</h4>
            <div className={'net ' + cls(b.netPnl)}>
              {usd2(b.netPnl)}
            </div>

            <div className="kv">
              <span>target δ</span>
              <span>{fmt(b.targetUnits, 4)} BTC</span>
            </div>

            <div className="kv">
              <span>spread capture</span>
              <span className="pos">{usd(b.spreadCapture)}</span>
            </div>

            <div className="kv">
              <span>inventory P&L</span>
              <span className={cls(b.inventoryPnl)}>
                {usd(b.inventoryPnl)}
              </span>
            </div>

            <div className="kv">
              <span>hedge P&L</span>
              <span className={cls(b.hedgePnl)}>
                {usd(b.hedgePnl)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}