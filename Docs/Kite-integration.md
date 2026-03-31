
# Kite Integration — TAlgo

## Overview

This document explains how TAlgo integrates with Kite Connect API to fetch market data, build OHLC candles, compute indicators, and execute trades.

The system is designed as a low-latency, event-driven pipeline.

Kite WebSocket → Tick Data → Candle Builder → Indicators → Strategy → Execution

---

## 1. Authentication

TAlgo authenticates using API key and access token.


const { KiteConnect, KiteTicker } = require("kiteconnect");

const kc = new KiteConnect({
  api_key: process.env.KITE_API_KEY
});

kc.setAccessToken(process.env.KITE_ACCESS_TOKEN);

const ticker = new KiteTicker({
  api_key: process.env.KITE_API_KEY,
  access_token: process.env.KITE_ACCESS_TOKEN
});


---
2.Historical Data (Warmup)

Used to initialize indicator values before live execution.

async function loadHistorical(instrument, from, to) {
  return await kc.getHistoricalData(instrument, from, to, "60minute");
}


---
3.OHLC Data Structure

Candles are stored in arrays for efficient computation.

const ohlc = {
  time: [],
  open: [],
  high: [],
  low: [],
  close: []
};


---
4.WebSocket Connection

Real-time data is received using Kite WebSocket.

ticker.on("connect", () => {
  ticker.subscribe([738561]);
  ticker.setMode(ticker.modeFull, [738561]);
});

ticker.on("ticks", (ticks) => {
  const tick = ticks[0];
  onTick(tick.last_price, tick.exchange_timestamp);
});


---
5.Candle Construction (1 Hour)

Ticks are grouped into 1-hour candles using time-bucket logic.

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
    currentCandle = {
      open: price,
      high: price,
      low: price,
      close: price
    };
    return;
  }

  if (bucket === currentBucket) {
    currentCandle.high = Math.max(currentCandle.high, price);
    currentCandle.low = Math.min(currentCandle.low, price);
    currentCandle.close = price;
  } else {
    pushCandle(currentCandle);
    currentBucket = bucket;
    currentCandle = {
      open: price,
      high: price,
      low: price,
      close: price
    };
  }
}


---

6.Storing Candles

Closed candles are pushed into OHLC arrays.

function pushCandle(c) {
  ohlc.open.push(c.open);
  ohlc.high.push(c.high);
  ohlc.low.push(c.low);
  ohlc.close.push(c.close);
}


---
7.Indicators

EMA

function EMA(values, period) {
  const k = 2 / (period + 1);
  let ema = values[0];
  return values.map(v => (ema = v * k + ema * (1 - k)));
}


---

HMA

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

function HMA(values, period) {
  const half = Math.floor(period / 2);
  const sqrt = Math.floor(Math.sqrt(period));

  const wma1 = WMA(values, half);
  const wma2 = WMA(values, period);

  const diff = wma1.map((v, i) => 2 * v - (wma2[i] || 0));

  return WMA(diff, sqrt);
}


---

ALMA

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


---

8.Strategy Flow

After each candle close:

OHLC → Indicators → Signal → Execution

Example:

function signal(close, ema, hma, alma) {
  if (close > ema && hma > alma) return "BUY";
  if (close < ema && hma < alma) return "SELL";
  return "NO_TRADE";
}


---

9.Order Execution

Orders are placed using Kite REST API.

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


---
10.Summary

TAlgo integrates Kite API as follows:

Authenticate → Historical Data → WebSocket → Tick Processing → Candle → Indicators → Strategy → Orders

The system is designed for low latency, deterministic execution, and real-time trading conditions.

---

