/**
 * experiment.js
 * Prototype – ALMA High / Low decision engine
 * Paper-trade logic only (NO real execution)
 * 15-minute evaluation cycle
 *
 * NOTE:
 * - Broker API keys removed intentionally
 * - This file demonstrates system design & logic only
 */

const fs = require("fs");

/* ================= CONFIG ================= */

const SYMBOL = "MCX:ZINC_FUTURE";   // example symbol
const INTERVAL = "15minute";
const CHECK_EVERY = 15 * 60 * 1000; // 15 minutes
const MAX_CANDLES = 200;
const LOG_FILE = "experiment.log";

/* ================= STATE ================= */

let closes = [];
let position = "NONE"; // BUY | SELL | NONE

/* ================= UTIL ================= */

function log(msg) {
  const time = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${time}] ${msg}\n`);
  console.log(`[${time}] ${msg}`);
}

/* ================= ALMA ================= */

function alma(values, length = 9, offset = 0.85, sigma = 6) {
  if (values.length < length) return null;

  const m = Math.floor(offset * (length - 1));
  const s = length / sigma;

  let sum = 0;
  let norm = 0;

  for (let i = 0; i < length; i++) {
    const w = Math.exp(-((i - m) ** 2) / (2 * s * s));
    sum += values[values.length - length + i] * w;
    norm += w;
  }

  return sum / norm;
}

/* ================= DECISION LOGIC ================= */
/**
 * v5.1 – ALMA Confirmation
 * BUY  → price above ALMA High & Low
 * SELL → price below ALMA High & Low
 * Else → transition (no trade)
 */

function decide(price, almaHigh, almaLow) {
  if (price > almaHigh && price > almaLow && position !== "BUY") {
    return { action: "BUY", reason: "Above ALMA High & Low" };
  }

  if (price < almaHigh && price < almaLow && position !== "SELL") {
    return { action: "SELL", reason: "Below ALMA High & Low" };
  }

  return { action: "NO_TRADE", reason: "Transition zone" };
}

/* ================= MOCK DATA SOURCE ================= */
/**
 * Replaces broker API for prototype.
 * Simulates incoming market prices.
 */

function mockMarketPrice() {
  const base = closes.length ? closes[closes.length - 1] : 370;
  return base + (Math.random() - 0.5) * 2;
}

/* ================= CORE LOOP ================= */

function run() {
  const price = mockMarketPrice();
  closes.push(price);

  // memory safety
  if (closes.length > MAX_CANDLES) {
    closes.shift();
  }

  const almaBase = alma(closes);
  if (!almaBase) {
    log("Waiting for sufficient data...");
    return;
  }

  const almaHigh = almaBase * 1.002;
  const almaLow = almaBase * 0.998;

  const decision = decide(price, almaHigh, almaLow);

  log(
    `Price=${price.toFixed(2)} | ALMA_H=${almaHigh.toFixed(2)} | ALMA_L=${almaLow.toFixed(2)} | POS=${position}`
  );

  if (decision.action === "BUY") {
    position = "BUY";
    log(`PAPER BUY → ${decision.reason}`);
  } 
  else if (decision.action === "SELL") {
    position = "SELL";
    log(`PAPER SELL → ${decision.reason}`);
  } 
  else {
    log(`NO TRADE → ${decision.reason}`);
  }
}

/* ================= SCHEDULER ================= */

log("=== ALMA EXPERIMENT (PROTOTYPE) STARTED ===");
run();
setInterval(run, CHECK_EVERY);

/* ================= HEALTH MONITOR ================= */

setInterval(() => {
  const mem = process.memoryUsage().rss / 1024 / 1024;
  log(`HEALTH → Memory ${mem.toFixed(2)} MB`);
}, 60 * 60 * 1000);
