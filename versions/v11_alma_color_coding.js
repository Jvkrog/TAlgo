"use strict";

// ─── TAlgo v11 — ALMA FAST COLOR ENGINE ───────────────────────────────
//
// CORE IDEA:
// One line → One decision
//
// GREEN → LONG
// RED   → SHORT
// GREY  → NO TRADE (SIDEWAYS)
//
// No probe. No scaling. No complexity.
// Clean execution.
//

require("dotenv").config();

const { KiteConnect, KiteTicker } = require("kiteconnect");
const fs = require("fs");

// ─── CONFIG ───────────────────────────────────────────────────────────
const API_KEY      = process.env.API_KEY;
const ACCESS_TOKEN = fs.readFileSync("access_code.txt", "utf8").trim();

const SYMBOL_TOKEN = 124791303; // NATGASMINI

const ALMA_FAST = 20;
const BAND_LEN  = 50;

const ATR_LEN        = 14;
const COMPRESS_MULT  = 0.4;
const SLOPE_MULT     = 0.05;

const LOT_MULT = 250;
const LOTS     = 5;

// ─── STATE ────────────────────────────────────────────────────────────
let candles = [];
let position = null;
let entryPrice = 0;
let state = "GREY"; // GREEN / RED / GREY

// ─── ALMA ─────────────────────────────────────────────────────────────
function alma(values, len, offset = 0.85, sigma = 6) {
    if (values.length < len) return null;
    const m = offset * (len - 1);
    const s = len / sigma;

    let sum = 0, norm = 0;

    for (let i = 0; i < len; i++) {
        const w = Math.exp(-((i - m) ** 2) / (2 * s * s));
        sum += values[values.length - len + i] * w;
        norm += w;
    }
    return sum / norm;
}

// ─── ATR ──────────────────────────────────────────────────────────────
function atr(candles, len) {
    if (candles.length < len + 1) return null;

    let trSum = 0;
    for (let i = candles.length - len; i < candles.length; i++) {
        const c = candles[i];
        const prev = candles[i - 1];

        const tr = Math.max(
            c.high - c.low,
            Math.abs(c.high - prev.close),
            Math.abs(c.low - prev.close)
        );
        trSum += tr;
    }
    return trSum / len;
}

// ─── SIDEWAYS DETECTION ───────────────────────────────────────────────
function getBandWidth(candles) {
    const highs = candles.map(c => c.high);
    const lows  = candles.map(c => c.low);

    const high = alma(highs, BAND_LEN);
    const low  = alma(lows, BAND_LEN);

    if (!high || !low) return null;

    return high - low;
}

// ─── FAST STATE LOGIC ─────────────────────────────────────────────────
function getState(fast, prevFast, candles, currentATR) {

    const slope = fast - prevFast;
    const bandWidth = getBandWidth(candles);

    if (bandWidth && bandWidth < currentATR * COMPRESS_MULT) {
        return "GREY";
    }

    if (slope > currentATR * SLOPE_MULT) return "GREEN";
    if (slope < -currentATR * SLOPE_MULT) return "RED";

    return "GREY";
}

// ─── EXECUTION ────────────────────────────────────────────────────────
function execute(price, newState) {

    // EXIT FIRST
    if (position === "LONG" && newState !== "GREEN") {
        const pnl = (price - entryPrice) * LOT_MULT * LOTS;
        console.log(`EXIT LONG @ ${price} PnL: ₹${pnl.toFixed(0)}`);
        position = null;
    }

    if (position === "SHORT" && newState !== "RED") {
        const pnl = (entryPrice - price) * LOT_MULT * LOTS;
        console.log(`EXIT SHORT @ ${price} PnL: ₹${pnl.toFixed(0)}`);
        position = null;
    }

    // ENTRY
    if (!position) {
        if (newState === "GREEN") {
            position = "LONG";
            entryPrice = price;
            console.log(`ENTER LONG @ ${price}`);
        }

        if (newState === "RED") {
            position = "SHORT";
            entryPrice = price;
            console.log(`ENTER SHORT @ ${price}`);
        }
    }

    state = newState;
}

// ─── CORE LOOP ────────────────────────────────────────────────────────
function process(price) {

    if (candles.length < ALMA_FAST + 5) return;

    const closes = candles.map(c => c.close);

    const fast     = alma(closes, ALMA_FAST);
    const prevFast = alma(closes.slice(0, -1), ALMA_FAST);
    const currentATR = atr(candles, ATR_LEN);

    if (!fast || !prevFast || !currentATR) return;

    const newState = getState(fast, prevFast, candles, currentATR);

    console.log(`STATE: ${newState} | PRICE: ${price}`);

    execute(price, newState);
}

// ─── CANDLE BUILDER (1H) ──────────────────────────────────────────────
let currentCandle = null;
let currentHour = null;

function onTick(price) {

    const now = new Date();
    const hour = now.getHours();

    if (hour !== currentHour) {

        if (currentCandle) {
            candles.push(currentCandle);
            if (candles.length > 200) candles.shift();

            process(currentCandle.close);
        }

        currentHour = hour;
        currentCandle = {
            open: price,
            high: price,
            low: price,
            close: price
        };

    } else {
        currentCandle.high = Math.max(currentCandle.high, price);
        currentCandle.low  = Math.min(currentCandle.low, price);
        currentCandle.close = price;
    }
}

// ─── WS ───────────────────────────────────────────────────────────────
const ticker = new KiteTicker({ api_key: API_KEY, access_token: ACCESS_TOKEN });

ticker.connect();

ticker.on("connect", () => {
    console.log("WS Connected");
    ticker.subscribe([SYMBOL_TOKEN]);
    ticker.setMode(ticker.modeLTP, [SYMBOL_TOKEN]);
});

ticker.on("ticks", ticks => {
    if (!ticks.length) return;
    const price = ticks[0].last_price;
    if (!price) return;

    onTick(price);
});

console.log("TAlgo running...");
