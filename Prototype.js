/**
 * TAlgo – ALMA High / Low Prototype
 * Mode: DRY-RUN by default
 * Execution: Disabled unless API credentials are provided
 *
 * Strategy Versions:
 * v5.0  : C > ALMA_HIGH  -> BUY
 *         C < ALMA_LOW   -> SELL
 *
 * v5.1  : C > ALMA_HIGH && C > ALMA_LOW -> BUY
 *         C < ALMA_HIGH && C < ALMA_LOW -> SELL
 *
 * Check Interval: 15 minutes
 */

"use strict";

// ================= CONFIG =================

const MODE = "DRY_RUN"; // change to "LIVE" only with env vars
const STRATEGY_VERSION = "v5.1";
const CHECK_INTERVAL_MIN = 15;

// Symbol example (paper)
const SYMBOL = "ZN-FUT";

// ================= AUTH BLOCK =================

function authenticateKite() {
  if (!process.env.KITE_API_KEY || !process.env.KITE_ACCESS_TOKEN) {
    console.log("[AUTH] No API credentials found → DRY-RUN mode");
    return null;
  }

  const { KiteConnect } = require("kiteconnect");
  const kite = new KiteConnect({
    api_key: process.env.KITE_API_KEY,
  });

  kite.setAccessToken(process.env.KITE_ACCESS_TOKEN);
  return kite;
}

const kite = authenticateKite();

// ================= INDICATORS =================

function calculateALMA(values, period = 9, offset = 0.85, sigma = 6) {
  if (values.length < period) return null;

  const m = Math.floor(offset * (period - 1));
  const s = period / sigma;
  let norm = 0;
  let sum = 0;

  for (let i = 0; i < period; i++) {
    const w = Math.exp(-((i - m) ** 2) / (2 * s * s));
    norm += w;
    sum += values[values.length - period + i] * w;
  }

  return sum / norm;
}

// ================= DATA MOCK =================
// (Replace with Kite historical fetch in LIVE mode)

function getMarketData() {
  // mock candle close prices
  const closes = [];
  for (let i = 0; i < 50; i++) {
    closes.push(300 + Math.random() * 20);
  }
  return closes;
}

// ================= STRATEGY =================

function decideTrade(close, almaHigh, almaLow) {
  if (!almaHigh || !almaLow) return null;

  if (STRATEGY_VERSION === "v5.0") {
    if (close > almaHigh) return "BUY";
    if (close < almaLow) return "SELL";
  }

  if (STRATEGY_VERSION === "v5.1") {
    if (close > almaHigh && close > almaLow) return "BUY";
    if (close < almaHigh && close < almaLow) return "SELL";
  }

  return null;
}

// ================= EXECUTION =================

function executeTrade(side, price) {
  const order = {
    symbol: SYMBOL,
    side,
    price,
    time: new Date().toISOString(),
  };

  if (!kite) {
    console.log("[DRY-RUN ORDER]", order);
    return;
  }

  // Real execution (disabled without creds)
  kite.placeOrder("regular", order);
}

// ================= LOGGING =================

function logStatus(close, almaHigh, almaLow, decision) {
  console.log("--------------------------------------------------");
  console.log("TIME        :", new Date().toLocaleString());
  console.log("CLOSE       :", close.toFixed(2));
  console.log("ALMA HIGH   :", almaHigh?.toFixed(2));
  console.log("ALMA LOW    :", almaLow?.toFixed(2));
  console.log("DECISION    :", decision || "HOLD");
}

// ================= MAIN LOOP =================

function runAlgo() {
  const prices = getMarketData();

  const almaHigh = calculateALMA(prices);
  const almaLow = calculateALMA(prices.map(p => p - 1)); // simulated low band
  const close = prices[prices.length - 1];

  const decision = decideTrade(close, almaHigh, almaLow);

  logStatus(close, almaHigh, almaLow, decision);

  if (decision) {
    executeTrade(decision, close);
  }
}

console.log("=== TAlgo ALMA EXPERIMENT STARTED ===");
console.log("Mode:", kite ? "LIVE" : "DRY-RUN");
console.log("Strategy:", STRATEGY_VERSION);

runAlgo();
setInterval(runAlgo, CHECK_INTERVAL_MIN * 60 * 1000);
