
# Architecture — TAlgo-X

## Overview

TAlgo-X is a real-time, event-driven trading system designed to process live market data, construct candles, compute indicators, and execute trades with low latency and deterministic behavior.

The system follows a modular pipeline architecture.

---



## High-Level Architecture
```
┌────────────────────┐
            │   Kite WebSocket   │
            │   (Live Ticks)     │
            └─────────┬──────────┘
                      │
                      ▼
            ┌────────────────────┐
            │   Tick Handler     │
            │  (Non-blocking)    │
            └─────────┬──────────┘
                      │
                      ▼
            ┌────────────────────┐
            │  Candle Builder    │
            │  (1H Aggregation)  │
            └─────────┬──────────┘
                      │
                      ▼
            ┌────────────────────┐
            │    OHLC Arrays     │
            │  (In-Memory Store) │
            └─────────┬──────────┘
                      │
                      ▼
            ┌────────────────────┐
            │    Indicators      │
            │ EMA / HMA / ALMA   │
            └─────────┬──────────┘
                      │
                      ▼
            ┌────────────────────┐
            │   Strategy Engine  │
            │  (State Machine)   │
            └─────────┬──────────┘
                      │
                      ▼
            ┌────────────────────┐
            │  Execution Engine  │
            │  (Order Placement) │
            └─────────┬──────────┘
                      │
                      ▼
            ┌────────────────────┐
            │   Kite REST API    │
            └────────────────────┘




```







---

## Data Flow

Tick → onTick() → Candle → OHLC → Indicators → Signal → Order

### Step-by-step

1. WebSocket streams live ticks
2. Tick handler processes each tick (non-blocking)
3. Candle builder aggregates ticks into 1-hour OHLC
4. Closed candles are stored in arrays
5. Indicators are computed on close prices
6. Strategy evaluates signals
7. Orders are executed via REST API

---

## Module Breakdown

### 1. Tick Handler

- Receives live ticks
- Extracts price and timestamp
- Forwards to candle builder

```javascript
function onTick(price, ts) {
  const bucket = getHourBucket(ts);
  // route to candle builder
}
```
Design Goal

Must be extremely fast

No blocking operations


---

### 2. Candle Builder

Responsible for converting ticks into OHLC candles.
```javascript
function onTick(price, ts) {
  if (!currentCandle) {
    currentCandle = { open: price, high: price, low: price, close: price };
    return;
  }

  currentCandle.high = Math.max(currentCandle.high, price);
  currentCandle.low = Math.min(currentCandle.low, price);
  currentCandle.close = price;
}
```
Design Goal

Accurate OHLC construction

Time-synchronized using exchange timestamps



---

### 3. OHLC Storage

Stores structured candle data for fast computation.
```javascript
const ohlc = {
  open: [],
  high: [],
  low: [],
  close: []
};
```
Design Goal

Fast array access

Optimized for indicator calculations


---

### 4. Indicator Engine

Computes EMA, HMA, ALMA on OHLC arrays.
```javascript
const ema = EMA(ohlc.close, 20);
const hma = HMA(ohlc.close, 16);
const alma = ALMA(ohlc.close, 9);

Design Goal

Efficient computation

Minimal recalculation overhead

```

---

### 5. Strategy Engine

Implements decision logic based on indicator outputs.
```javascript
function signal(close, ema, hma, alma) {
  if (close > ema && hma > alma) return "BUY";
  if (close < ema && hma < alma) return "SELL";
  return "NO_TRADE";
}
```
Design Goal

Deterministic decisions

Avoid noise-based trades

---

### 6. Execution Engine

Handles order placement through Kite API.
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
Design Goal

Reliable execution

Minimal delay from signal to order

---

System Characteristics

Event-Driven Architecture

No polling

Reacts instantly to incoming data

---

Low Latency

WebSocket-based data ingestion

Minimal processing overhead

---

Deterministic Behavior

Same input → same output

No randomness in decision logic

---

In-Memory Processing

OHLC stored in arrays

Faster than DB-based computation

---

Design Decisions

Why WebSocket over REST

Real-time data vs delayed polling

---

Why Arrays for OHLC

Faster indexing for indicators

Lower overhead than object structures

---

Why Time-Bucket Candles

Ensures consistent candle formation

Prevents drift

---

Why Event-Driven Model

Eliminates blocking delays

Scales better under high-frequency ticks

---

Latency Considerations

Critical path:

Tick → Candle → Indicator → Signal → Order

Optimizations

No DB calls inside tick handler

No heavy logging in real-time loop

Indicator calculations only on candle close

---

Failure Handling (Basic)

Wrap tick processing in try/catch

Use PM2 for auto-restart

Maintain minimal state in memory

---

Summary

TAlgo is built as a structured real-time system:

WebSocket → Tick → Candle → Indicators → Strategy → Execution

The architecture prioritizes:

speed

stability

deterministic execution


This design enables reliable performance under live market conditions.

