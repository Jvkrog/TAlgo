```md
# Kite Integration — TAlgo

> Production-oriented Kite API integration with real-time data processing and deterministic execution pipeline.

---

## Overview

This document explains how TAlgo integrates with Kite Connect API to fetch market data, construct OHLC candles, compute indicators, and execute trades.

The system follows an event-driven architecture optimized for low latency.

```
Kite WebSocket → Tick Data → Candle Builder → Indicators → Strategy → Execution
```

---

## 1. Authentication

TAlgo initializes both REST and WebSocket clients using secure environment variables.

```javascript
const { KiteConnect, KiteTicker } = require("kiteconnect");

// REST client for historical data and order execution
const kc = new KiteConnect({
  api_key: process.env.KITE_API_KEY
});

// Required for authenticated API access
kc.setAccessToken(process.env.KITE_ACCESS_TOKEN);

// WebSocket client for live tick streaming
const ticker = new KiteTicker({
  api_key: process.env.KITE_API_KEY,
  access_token: process.env.KITE_ACCESS_TOKEN
});
```

Why this matters:  
This enables secure communication with Kite APIs and separates REST (orders/data) from WebSocket (live ticks).

---

## 2. Historical Data (Warmup)

Initial historical candles are fetched to bootstrap indicator calculations before live trading begins.

```javascript
async function loadHistorical(instrument, from, to) {
  try {
    return await kc.getHistoricalData(instrument, from, to, "60minute");
  } catch (err) {
    console.error("Historical data fetch failed:", err);
    return [];
  }
}
```

Why this matters:  
Indicators like EMA and ALMA require previous data. Without warmup, early signals would be invalid.

---

## 3. OHLC Data Structure

All candle data is stored in arrays for fast computation and direct indexing.

```javascript
const ohlc = {
  time: [],
  open: [],
  high: [],
  low: [],
  close: []
};
```

Why this matters:  
Array-based storage enables efficient indicator calculations and avoids overhead from complex data structures.

---

## 4. WebSocket Connection

Live market data is received using Kite WebSocket.

```javascript
ticker.on("connect", () => {
  ticker.subscribe([738561]);
  ticker.setMode(ticker.modeFull, [738561]);
});

ticker.on("ticks", (ticks) => {
  const tick = ticks[0];
  onTick(tick.last_price, tick.exchange_timestamp);
});
```

Why this matters:  
WebSocket provides real-time streaming, which is critical for low-latency trading systems.

---

## 5. Candle Construction (1 Hour)

Ticks are aggregated into 1-hour OHLC candles using time-bucket logic.

```javascript
let currentCandle = null;
let currentBucket = null;

function getHourBucket(ts) {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function onTick(price, ts) {
  const bucket = getHourBucket(ts);

  if (!currentCandle) {
    currentBucket = bucket;
    currentCandle = { open: price, high: price, low: price, close: price };
    return;
  }

  if (bucket === currentBucket) {
    currentCandle.high = Math.max(currentCandle.high, price);
    currentCandle.low = Math.min(currentCandle.low, price);
    currentCandle.close = price;
  } else {
    pushCandle(currentCandle);
    currentBucket = bucket;
    currentCandle = { open: price, high: price, low: price, close: price };
  }
}
```

Why this matters:  
Ensures accurate OHLC candle formation from tick-level data.

---

## 6. Storing Candles

```javascript
function pushCandle(c) {
  ohlc.open.push(c.open);
  ohlc.high.push(c.high);
  ohlc.low.push(c.low);
  ohlc.close.push(c.close);
}
```

Why this matters:  
Forms the base for indicator calculations.

---

## 7. Indicators

### EMA

```javascript
function EMA(values, period) {
  const k = 2 / (period + 1);
  let ema = values[0];
  return values.map(v => (ema = v * k + ema * (1 - k)));
}
```

---

### HMA

```javascript
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
```

---

### ALMA

```javascript
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
```

---

## 8. Strategy Flow

```
OHLC → Indicators → Signal → Execution
```

```javascript
function signal(close, ema, hma, alma) {
  if (close > ema && hma > alma) return "BUY";
  if (close < ema && hma < alma) return "SELL";
  return "NO_TRADE";
}
```

---

## 9. Order Execution

```javascript
async function placeOrder(symbol, type) {
  return await kc.placeOrder("regular", {
    exchange: "MCX",
    tradingsymbol: symbol,
    transaction_type: type,
    quantity: 1,
    product: "MIS",
    order_type: "MARKET"
  });
}
```

---

## 10. Summary

```
Authenticate → Historical → WebSocket → Tick → Candle → Indicators → Strategy → Orders
```
```

---

