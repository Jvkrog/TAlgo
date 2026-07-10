## Kite Integration — TAlgo-X (Phase 2)

> Hybrid architectural implementation leveraging 15-minute REST API polling for deterministic indicator data alongside real-time WebSocket streaming for ephemeral risk and live PnL tracking.

------------------------------
## Overview
This document explains how TAlgo-X integrates with the Kite Connect API in its Phase 2 architecture. To eliminate data corruption caused by network drops during live tick aggregation, the system decouples state validation from streaming metrics:

   1. REST API Polling: Runs an interval loop every 15 minutes to pull clean, exchange-verified candles for precise indicator calculation.
   2. WebSocket Streaming: Streams live prices solely to monitor portfolio PnL and instantly enforce risk boundaries.

Kite REST API (15 Min Poll) ──> Historical Candles ──> Indicators ──> Strategy ──┐
                                                                               ├──> Execution State Machine
Kite WebSocket (Live Ticks) ──> Last Traded Price ──> Instant PnL ──> Risk ─────┘

------------------------------
## 1. Authentication
TAlgo-X initializes separate REST and WebSocket clients using secure environment variables to isolate HTTP request state from the incoming streaming network socket.

const { KiteConnect, KiteTicker } = require("kiteconnect");
// REST client for interval historical data polls and order executionconst kc = new KiteConnect({
  api_key: process.env.KITE_API_KEY
});
// Required for authenticated API access
kc.setAccessToken(process.env.KITE_ACCESS_TOKEN);
// WebSocket client for real-time risk telemetry ingestionconst ticker = new KiteTicker({
  api_key: process.env.KITE_API_KEY,
  access_token: process.env.KITE_ACCESS_TOKEN
});

Why this matters:
This setup separates high-volume streaming data layers from transactional request paths, preventing thread blocking during sudden market spikes.
------------------------------
## 2. Historical Data & Interval Polling
Instead of manually constructing candles from unstable tick strings, a cron or scheduler calls the historical endpoint every 15 minutes to fetch uncorrupted data arrays.

const MAX_HISTORY = 200; // Sized buffer to prevent V8 engine memory leaks
async function pollIntervalData(instrument, from, to) {
  try {
    const candles = await kc.getHistoricalData(instrument, from, to, "15minute");
    if (candles && candles.length > 0) {
      synchronizeEngineArrays(candles);
    }
  } catch (err) {
    console.error("[CRITICAL] Historical interval poll failed:", err.message);
  }
}
function synchronizeEngineArrays(candles) {
  // Map and bound incoming data to maintain a constant memory profile
  ohlc.open = candles.map(c => c.open).slice(-MAX_HISTORY);
  ohlc.high = candles.map(c => c.high).slice(-MAX_HISTORY);
  ohlc.low = candles.map(c => c.low).slice(-MAX_HISTORY);
  ohlc.close = candles.map(c => c.close).slice(-MAX_HISTORY);
}

Why this matters:
Using exchange-computed candles ensures indicators remain accurate even if the local server briefly disconnects or drops packets mid-session.
------------------------------
## 3. OHLC Data Structure
All candle data is kept in bounded, parallel arrays for fast matrix computation and indexing.

const ohlc = {
  time: [],
  open: [],
  high: [],
  low: [],
  close: []
};

Why this matters:
Array-based contiguous storage enables sub-millisecond indicator parsing loops and completely cuts out complex object layer overhead.
------------------------------
## 4. WebSocket Telemetry Connection
Live data ingestion streams continuous prices strictly to pass values to ephemeral risk math tracks.

ticker.on("connect", () => {
  ticker.subscribe([738561]); // Subscribe to specific target instrument token
  ticker.setMode(ticker.modeFull, [738561]);
});

ticker.on("ticks", (ticks) => {
  if (!ticks || ticks.length === 0) return;
  const tick = ticks[0];
  
  // Guard clause against partial heartbeat or missing metadata packets
  if (!tick.last_price) return;

  evaluateLiveMetrics(tick.last_price);
});

Why this matters:
The socket is freed from compiling bar history boundaries, allowing incoming tick evaluations to complete inside a lean, constant time complexity ($O(1)$) loop.
------------------------------
## 5. Ephemeral PnL & Risk Circuit Breaking
Streaming tick inputs feed into active, context-aware state mirrors to monitor system drawdown bounds instantly.

let activePosition = {
  average_price: 125.40,
  quantity: 1,
  direction: "BUY"
};
function evaluateLiveMetrics(lastPrice) {
  if (!activePosition) return;

  let livePnL = 0;
  if (activePosition.direction === "BUY") {
    livePnL = (lastPrice - activePosition.average_price) * activePosition.quantity;
  } else {
    livePnL = (activePosition.average_price - lastPrice) * activePosition.quantity;
  }

  enforceRiskControls(livePnL);
}
function enforceRiskControls(pnl) {
  const HARD_STOP_THRESHOLD = -5000;
  if (pnl <= HARD_STOP_THRESHOLD) {
    console.warn(`[RISK CIRCUIT BREACHED] Executing immediate account liquidation. PnL: ${pnl}`);
    emergencyLiquidate();
  }
}

Why this matters:
Decoupled risk evaluations happen in real time, serving as an absolute safety barrier independent of signal generation.
------------------------------
## 6. Indicators## EMA

function EMA(values, period) {
  const k = 2 / (period + 1);
  let ema = values[0];
  return values.map(v => (ema = v * k + ema * (1 - k)));
}

------------------------------
## HMA

function WMA(values, period) {
  const denom = (period * (period + 1)) / 2;

  return values.map((_, i) => {
    if (i < period - 1) return null;

    let sum = 0, w = 1;
    for (let j = i - period + 1; j <= i; j++) {
      sum += values[j] * w++;
    }
    return sum / denom;
  });
}

------------------------------
## ALMA

function ALMA(values, period = 9, offset = 0.85, sigma = 6) {
  const m = offset * (period - 1);
  const s = period / sigma;

  return values.map((_, i) => {
    if (i < period - 1) return null;

    let sum = 0, norm = 0;

    for (let j = 0; j < period; j++) {
      const w = Math.exp(-((j - m) ** 2) / (2 * s * s));
      sum += values[i - period + 1 + j] * w;
      norm += w;
    }

    return sum / norm;
  });
}

------------------------------
## 7. Strategy Flow

OHLC (Polled Matrix) → Indicators → Signal Execution Trigger

function signal(close, ema, hma, alma) {
  if (close > ema && hma > alma) return "BUY";
  if (close < ema && hma < alma) return "SELL";
  return "NO_TRADE";
}

------------------------------
## 8. Order Execution
Order injection runs wrapped in isolated error barriers, ensuring that API rate drops or network timeouts never crash the core event loop.

async function placeOrder(symbol, type) {
  try {
    return await kc.placeOrder("regular", {
      exchange: "MCX",
      tradingsymbol: symbol,
      transaction_type: type,
      quantity: 1,
      product: "MIS",
      order_type: "MARKET"
    });
  } catch (err) {
    console.error(`[EXECUTION TRAPPED ERRROR] Failed to route order for ${symbol}:`, err.message);
    return null;
  }
}

------------------------------
## 9. Summary

Authenticate Clients → Poll Verified 15-Min Candles → Refresh Indicator Arrays → Stream WebSocket Ticks → Calculate Ephemeral PnL & Evaluate Risk Stops → Dispatch Orders via Isolated HTTP REST

------------------------------


