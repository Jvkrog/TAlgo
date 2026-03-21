// ─────────────────────────────────────────────────────────────────────────────
// TAlgo V3 ENGINE — NatGas (MCX)
//
// Architecture:
//   SLOW brain  — ALMA(21/55) on full lot contract → sets directional bias
//   FAST engine — ALMA(9/21)  on mini contract     → executes, scales, exits
//   GLOBAL      — shared state: position, capital, PnL, exposure
//
// Capital rules:
//   SLOW anchor → 1 full lot  (NATGAS26MARFUT)
//   FAST scale  → up to 5 mini lots (NATGASMINI26MARFUT)
//   Total cap   → 6 lots equivalent
//
// Conflict rule: FAST only trades when GLOBAL.bias !== 0 and cross === GLOBAL.bias
// Exit rule:     SLOW bias flip → exit ALL immediately
// ─────────────────────────────────────────────────────────────────────────────
"use strict";
require("dotenv").config();

const { KiteConnect, KiteTicker } = require("kiteconnect");
const axios = require("axios");
const fs    = require("fs");

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(msg){
    if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID){ console.log("[TG disabled]", msg); return; }
    try{
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            { chat_id: TELEGRAM_CHAT_ID, text: `[V3]\n${msg}` });
    }catch(err){ console.log("TG Error:", err.response?.data || err.message); }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
const ACCESS_FILE_PATH = "access_code.txt";
const ACCESS_TOKEN = fs.readFileSync(ACCESS_FILE_PATH, "utf8").trim();
const tokenDate    = new Date(fs.statSync(ACCESS_FILE_PATH).mtime).toLocaleString();
const startTime    = new Date();

// ─── SESSION ANALYTICS ────────────────────────────────────────────────────────
const tradeLog  = []; // {pnl, holdMs, tag} per closed trade — session summary
const eventLog  = []; // structured event stream — full trade lifecycle
let fastTradeCount = 0, slowTradeCount = 0, counterTradeCount = 0;
let peakATR = 0;
let sessionStartLogged = false;
let currentTradeId = null; // groups ENTRY→SCALE→PARTIAL→EXIT into one trade

function logEvent(obj){
    const event = { ...obj, ts: new Date().toISOString(), ms: Date.now(), tradeId: currentTradeId };
    eventLog.push(event);
    // Write to event_log.jsonl for offline analysis
    require("fs").appendFileSync("nat_events.jsonl", JSON.stringify(event) + "\n");
}

function healthCheck(){
    return [
        process.env.API_KEY ? "✅ API Key" : "❌ API Key Missing",
        ACCESS_TOKEN        ? "✅ Token"   : "❌ Token Missing",
        (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) ? "✅ Telegram" : "⚠ Telegram Off",
        `🕒 ${tokenDate}`
    ].join("\n");
}

// ─── INSTRUMENTS ──────────────────────────────────────────────────────────────
const API_KEY = process.env.API_KEY;

const SYM_SLOW = {                          // full lot — SLOW anchor
    tradingsymbol:    "NATGAS26MARFUT",     // ← UPDATE token before running
    exchange:         "MCX",
    instrument_token: 0,                    // ← UPDATE
    lot_multiplier:   1250
};

const SYM_FAST = {                          // mini lot — FAST execution
    tradingsymbol:    "NATGASMINI26MARFUT",
    exchange:         "MCX",
    instrument_token: 121628679,
    lot_multiplier:   250
};

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const INTERVAL     = "15minute";

// SLOW brain — wide ALMA cross for trend direction
const SLOW_SHORT   = 21;
const SLOW_LONG    = 55;

// FAST engine — tight ALMA cross for execution timing
const FAST_SHORT   = 9;
const FAST_LONG    = 21;

const ATR_LENGTH   = 14;
const ATR_HIST_LEN = 20;
const ATR_SMOOTH   = 10;

const CAPITAL         = 100000;
const BASE_DAILY_RISK = 0.03;
const TRAIL_DD_PCT    = 0.06;
const COOLDOWN_MS     = 3600000;
const MAX_TRADES_DAY  = 4;    // V2: fewer, higher quality
const MIN_TRADE_GAP   = 1800000;
const TRADE_COST      = 120;
const MAX_TRADE_DUR   = 5400000;
const STAGNATION_LIM  = 8;
const PRESSURE_THRESH = 6;

// Lot limits
const SLOW_MAX_LOTS   = 1;    // SLOW always exactly 1 full lot
const FAST_MAX_LOTS   = 5;    // FAST up to 5 mini lots
const TOTAL_LOT_CAP   = 10;   // hard ceiling in mini-equivalent units (1 full=5 + 5 mini=5)
const MIN_HOLD        = 5 * 60 * 1000; // 5 min minimum hold before exits fire

// ─── GLOBAL SHARED BRAIN ──────────────────────────────────────────────────────
// Single source of truth for position state across both engines
const G = {
    position:       null,
    avgPrice:       0,

    slowLot:        0,
    fastLots:       0,

    bias:           0,
    conviction:     0,
    biasSetTime:    0,
    neutralTime:    0,      // timestamp when bias last cleared — gates re-entry after chop
    counterLots:    0,      // fast mini lots open in opposite direction (counter trades)
    slowEntryPrice: 0,      // price when SLOW anchor entered — used as pullback reference

    sessionPnL:     0,
    fastPnL:        0,   // FAST engine cumulative PnL — independent DD control
    slowPnL:        0,   // SLOW anchor cumulative PnL — structural position
    tradesToday:    0,
    lastTradeTime:  0,
    lastPartialTime: 0,

    state:          "WAIT",
    tradeStartTime: null,
    isExiting:      false
};

// ─── RISK STATE ───────────────────────────────────────────────────────────────
const RS = { NORMAL:"NORMAL", DEFENSE:"DEFENSE", COOL_DOWN:"COOL_DOWN", RECOVERY:"RECOVERY", HARD_HALT:"HARD_HALT" };
let fastRiskState = RS.NORMAL, slowRiskState = RS.NORMAL;
let fastAllocation = 1.0; // 0.0=no trading 0.6=defense 0.8=recovery 1.0=normal 1.5=aggressive
let slowPeakPnL = 0;      // peak unrealized SLOW profit this position — tracks giveback
let fastCooldownStart = null, fastCooldownCandles = 0;
let fastDefenseLossCount = 0, fastRecoveryWinCount = 0, equityHigh = CAPITAL;

// ─── MARKET DATA ──────────────────────────────────────────────────────────────
const kc = new KiteConnect({ api_key: API_KEY });
kc.setAccessToken(ACCESS_TOKEN);

let livePrice = 0, lastTickPrice = 0;
let buyPressure = 0, sellPressure = 0;
let aggressiveBuy = false, aggressiveSell = false;
let currentATR = 0, previousATR = 0, atrHistory = [];

// ─── SLOW BRAIN STATE ─────────────────────────────────────────────────────────
let slowPrevCross = 0, slowPrevTrend = 0;

// ─── FAST ENGINE STATE ────────────────────────────────────────────────────────
let fastPrevCross = 0, fastPrevAlmaLong = 0;
let fastExitSignals = 0, fastLastScalePrice = 0;
let counterEntryPrice = 0;
let loopRunning = false, lastCandleExecuted = null;
let candlesWithoutTrade = 0, isProbe = false, isProbeTrade = false;
let lifecycleClosed = false, lifecycleShutdown = false;
let candleTradeLock = false;
let slowEnteredThisCandle = false;
let weakeningCount = 0;
let hardHaltProbeUsed = false; // allows 1 probe mini after HARD_HALT — resets after exit

const log = msg => console.log(`[${new Date().toLocaleTimeString()}][V3][F:${fastRiskState}|S:${slowRiskState}] ${msg}`);

// ─── INDICATORS ───────────────────────────────────────────────────────────────
function alma(values, length, offset = 0.85, sigma = 6){
    const m = offset * (length - 1), s = length / sigma, r = [];
    for(let i = length - 1; i < values.length; i++){
        let sum = 0, norm = 0;
        for(let j = 0; j < length; j++){
            const w = Math.exp(-((j - m) ** 2) / (2 * s * s));
            sum += values[i - length + 1 + j] * w; norm += w;
        }
        r.push(sum / norm);
    }
    return r;
}

function calcATR(data){
    const trs = [];
    for(let i = 1; i < data.length; i++){
        const { high, low } = data[i], pc = data[i-1].close;
        trs.push(Math.max(high - low, Math.abs(high - pc), Math.abs(low - pc)));
    }
    return trs.slice(-ATR_LENGTH).reduce((a, b) => a + b, 0) / ATR_LENGTH;
}

function updateATR(v){ atrHistory.push(v); if(atrHistory.length > ATR_HIST_LEN) atrHistory.shift(); }
function smoothATR(raw){
    if(atrHistory.length < ATR_SMOOTH) return raw;
    const a = 2 / (ATR_SMOOTH + 1); let v = atrHistory[0];
    for(let i = 1; i < atrHistory.length; i++) v = atrHistory[i] * a + v * (1 - a);
    return v;
}

// ─── POSITION MATH ────────────────────────────────────────────────────────────
// All exposure normalized to mini-equivalent units (1 full = 5 mini)
function getTotalExposure(){
    return (G.slowLot * 5) + G.fastLots; // mini-equivalent
}

function calculatePnL(price){
    if(!G.position) return 0;
    const dir  = G.position === "LONG" ? 1 : -1;
    const move = (price - G.avgPrice) * dir;
    return (G.slowLot * move * SYM_SLOW.lot_multiplier)
         + (G.fastLots * move * SYM_FAST.lot_multiplier);
}

function calculateSplitPnL(price){
    if(!G.position) return { fast: 0, slow: 0 };
    const dir  = G.position === "LONG" ? 1 : -1;
    const move = (price - G.avgPrice) * dir;
    return {
        slow: G.slowLot  * move * SYM_SLOW.lot_multiplier,
        fast: G.fastLots * move * SYM_FAST.lot_multiplier
    };
}

function updateAvgPrice(price, lots, isSlow, curUnits){
    // curUnits = mini-equivalent units BEFORE this lot was added (passed explicitly to avoid read-after-increment)
    const newUnits = lots * (isSlow ? 5 : 1);
    G.avgPrice = curUnits === 0 ? price
        : ((G.avgPrice * curUnits) + (price * newUnits)) / (curUnits + newUnits);
}


function fastGuards(){
    if(fastRiskState === RS.HARD_HALT){
        if(!hardHaltProbeUsed){ log("⚠ FAST HARD_HALT → 1 probe allowed"); return true; }
        log("Guard: FAST HARD_HALT (probe used)"); return false;
    }
    if(fastRiskState === RS.COOL_DOWN){
        const left = fastCooldownCandles > 0 ? `${fastCooldownCandles} candles` : `${Math.ceil((COOLDOWN_MS-(Date.now()-fastCooldownStart))/60000)}m`;
        log(`Guard: FAST COOL_DOWN — ${left}`); return false;
    }
    return true;
}

function slowGuards(){
    if(slowRiskState === RS.HARD_HALT){ log("Guard: SLOW HARD_HALT"); return false; }
    return true;
}

// ─── RISK STATE TRANSITIONS ───────────────────────────────────────────────────
function evaluateFastRisk(){
    const equity = CAPITAL + G.sessionPnL;
    equityHigh = Math.max(equityHigh, equity);
    const base  = CAPITAL * BASE_DAILY_RISK;
    const limit = Math.max(base * 0.5, base * (currentATR / 10));

    if(G.fastPnL < -limit * 1.5 || (equityHigh - equity) >= CAPITAL * TRAIL_DD_PCT){
        if(fastRiskState !== RS.HARD_HALT){ fastRiskState = RS.HARD_HALT; sendTelegram(`🔴 FAST HARD HALT
⚡F:₹${G.fastPnL.toFixed(0)} | Sess:₹${G.sessionPnL.toFixed(0)}`); }
        return;
    }
    if(fastRiskState === RS.COOL_DOWN){
        if(fastCooldownCandles > 0){ if(--fastCooldownCandles <= 0){ fastRiskState = RS.DEFENSE; fastDefenseLossCount = 0; sendTelegram("🟡 FAST SpikeCD→DEFENSE"); } }
        else if(Date.now() - fastCooldownStart >= COOLDOWN_MS){ fastRiskState = RS.DEFENSE; previousATR = currentATR; fastDefenseLossCount = 0; sendTelegram("🟡 FAST CD→DEFENSE"); }
        return;
    }
    const FAST_DD = CAPITAL * 0.01;
    if(fastRiskState === RS.NORMAL && G.fastPnL < -FAST_DD){ fastRiskState = RS.DEFENSE; fastDefenseLossCount = 0; sendTelegram(`🟡 FAST DEFENSE
⚡F:₹${G.fastPnL.toFixed(0)}`); return; }
    if(fastRiskState === RS.DEFENSE && G.fastPnL < -(FAST_DD * 1.5)){ fastCooldownStart = Date.now(); fastRiskState = RS.COOL_DOWN; sendTelegram(`🟠 FAST COOL_DOWN
Resume: ${new Date(fastCooldownStart+COOLDOWN_MS).toLocaleTimeString()}`); return; }
    if(fastRiskState === RS.DEFENSE && G.fastPnL > -(FAST_DD * 0.25)){ fastRiskState = RS.RECOVERY; fastRecoveryWinCount = 0; sendTelegram(`🔵 FAST RECOVERY
⚡F:₹${G.fastPnL.toFixed(0)}`); return; }
    if(fastRiskState === RS.RECOVERY && G.fastPnL > 0){ fastRiskState = RS.NORMAL; fastRecoveryWinCount = fastDefenseLossCount = 0; sendTelegram("🟢 FAST NORMAL"); }
    if(fastRiskState === RS.RECOVERY && G.fastPnL < -(FAST_DD * 0.25)){ fastRiskState = RS.DEFENSE; fastDefenseLossCount = 0; }
}

function evaluateSlowRisk(){
    const SLOW_DD = CAPITAL * 0.05;
    if(slowRiskState === RS.NORMAL && G.slowPnL < -SLOW_DD){
        slowRiskState = RS.DEFENSE;
        sendTelegram(`🐢 SLOW DEFENSE
🐢S:₹${G.slowPnL.toFixed(0)}`);
    }
    if(slowRiskState === RS.DEFENSE && G.slowPnL > 0){
        slowRiskState = RS.NORMAL;
        sendTelegram(`🐢 SLOW NORMAL restored
🐢S:₹${G.slowPnL.toFixed(0)}`);
    }
}

function updateFastAllocation(){
    switch(fastRiskState){
        case RS.NORMAL:    fastAllocation = 1.0; break;
        case RS.DEFENSE:   fastAllocation = 0.6; break;
        case RS.COOL_DOWN: fastAllocation = 0.0; break;
        case RS.RECOVERY:  fastAllocation = 0.8; break;
        case RS.HARD_HALT: fastAllocation = 0.0; break;
        default:           fastAllocation = 1.0;
    }
    log(`fastAlloc:${fastAllocation} [${fastRiskState}]`);
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
const ticker = new KiteTicker({ api_key: API_KEY, access_token: ACCESS_TOKEN });
ticker.connect();
ticker.on("connect", () => {
    // Subscribe to both instruments
    ticker.subscribe([SYM_SLOW.instrument_token, SYM_FAST.instrument_token].filter(t => t > 0));
    ticker.setMode(ticker.modeFull, [SYM_FAST.instrument_token]);
    log("WS Connected");
    sendTelegram(`🧠 V3 ENGINE Started\n📅 ${startTime.toLocaleDateString("en-IN", {weekday:"long", day:"2-digit", month:"short", year:"numeric"})}\n🕐 ${startTime.toLocaleTimeString()}\nSLOW ALMA(${SLOW_SHORT}/${SLOW_LONG}) FAST ALMA(${FAST_SHORT}/${FAST_LONG})\n\n${healthCheck()}`);
});
ticker.on("ticks", ticks => {
    if(fastRiskState === RS.HARD_HALT || !ticks.length) return;
    // Use FAST instrument for live price
    const fastTick = ticks.find(t => t.instrument_token === SYM_FAST.instrument_token);
    if(!fastTick) return;
    livePrice = fastTick.last_price;
    if(lastTickPrice > 0){
        if(livePrice > lastTickPrice){ buyPressure++; sellPressure = Math.max(0, sellPressure - 1); }
        else if(livePrice < lastTickPrice){ sellPressure++; buyPressure = Math.max(0, buyPressure - 1); }
        else { buyPressure = Math.max(0, buyPressure - 1); sellPressure = Math.max(0, sellPressure - 1); }
        aggressiveBuy  = buyPressure  >= PRESSURE_THRESH;
        aggressiveSell = sellPressure >= PRESSURE_THRESH;
    }
    lastTickPrice = livePrice;
    if(G.position && currentATR > 0){
        const pnl = calculateSplitPnL(livePrice);
        if(pnl.slow > slowPeakPnL) slowPeakPnL = pnl.slow; // track SLOW peak for giveback detection
        log(`💰 LIVE → ⚡F:₹${pnl.fast.toFixed(0)} 🐢S:₹${pnl.slow.toFixed(0)} TOTAL:₹${(pnl.fast+pnl.slow).toFixed(0)} | ${G.position} avg:${G.avgPrice.toFixed(2)} → ${livePrice.toFixed(2)}`);
    }
    // Trap exit in PROBATION
    if(G.position && G.state === "PROBATION" && currentATR && !G.isExiting){
        const trapThreshold = isProbeTrade ? 1.4 : 2.0;
        if(Math.abs(livePrice - G.avgPrice) > currentATR * trapThreshold){
            log(`⚠ Trap Exit @ ${livePrice} (${trapThreshold}×ATR)`);
            sendTelegram(`⚠ TRAP EXIT @ ${livePrice}`);
            if(G.counterLots > 0) exitCounter(livePrice);
            else exitFast(livePrice, "TRAP");
        }
    }
});

// ─── POSITION MANAGEMENT ──────────────────────────────────────────────────────

function placeOrder(dir, lots, tag){
    if(G.isExiting) return;
    if(candleTradeLock){ log(`🔒 Candle lock — skipping ${tag}`); return; }
    candleTradeLock = true;
    const price   = livePrice || G.avgPrice;
    const isSlow  = tag.includes("SLOW");
    const isFirst = getTotalExposure() === 0;

    // Count the trade on first entry — exitAll also increments, but we want accurate daily cap
    if(isFirst) G.tradesToday++;

    // Hard reset on brand-new position — must happen BEFORE lot increment
    if(isFirst){
        G.avgPrice = price;
        fastLastScalePrice = price;
    }

    // Capture units BEFORE incrementing — needed for correct weighted average
    const prevUnits = getTotalExposure();

    // Increment lots — track trend vs counter separately
    if(isSlow){
        G.slowLot += lots;
    } else if(tag === "FAST_COUNTER"){
        G.counterLots += lots;
        G.fastLots += lots;
    } else {
        G.fastLots += lots;
    }

    // Blend avgPrice only when adding to an existing position
    if(!isFirst) updateAvgPrice(price, lots, isSlow, prevUnits);

    // Only SLOW sets global direction — FAST counter must not flip G.position
    if(isSlow || isFirst) G.position = dir === 1 ? "LONG" : "SHORT";
    G.state = "PROBATION";
    G.tradeStartTime = G.tradeStartTime || Date.now();
    G.lastTradeTime = Date.now();
    if(isFirst) currentTradeId = `T${Date.now()}`; // new trade ID for this position lifecycle
    const eventType = isFirst ? "ENTRY" : "SCALE";
    logEvent({ type: eventType, subType: tag, direction: G.position, price, lots, exposure: getTotalExposure() });

    log(`📥 ${tag} ${G.position} +${lots}L @ ${price.toFixed(2)} avg:${G.avgPrice.toFixed(2)} miniExp:${getTotalExposure()} id:${currentTradeId}`);
    sendTelegram(`${dir===1?"🚀":"🔻"} ${tag} ${G.position}\n+${lots}L @ ₹${price.toFixed(2)} | avg:${G.avgPrice.toFixed(2)}\nExp:${getTotalExposure()}/10mini | F:${fastRiskState}`);
}

function exitAll(price, reason){
    if(G.isExiting || !G.position) return;
    G.isExiting = true;
    const { fast: fastPnlExit, slow: slowPnlExit } = calculateSplitPnL(price);
    const pnl = fastPnlExit + slowPnlExit;
    G.fastPnL    += fastPnlExit;
    G.slowPnL    += slowPnlExit;
    G.sessionPnL += pnl;
    const holdMs = G.tradeStartTime ? Date.now() - G.tradeStartTime : 0;
    tradeLog.push({ pnl, holdMs, tag: reason });
    logEvent({ type: "EXIT", reason, price, pnl, holdMs, slow: G.slowLot, fast: G.fastLots });
    if(G.slowLot > 0) slowTradeCount++; else fastTradeCount++;
    log(`🚪 EXIT ALL [${reason}] ${G.position} | slow:${G.slowLot} fast:${G.fastLots} | PnL:${pnl.toFixed(0)} ⚡F:${fastPnlExit.toFixed(0)} 🐢S:${slowPnlExit.toFixed(0)} | Sess:${G.sessionPnL.toFixed(0)}`);
    sendTelegram(`❌ EXIT ALL [${reason}]\n${G.position} slow:${G.slowLot} fast:${G.fastLots} @ ₹${price.toFixed(2)}\nPnL:${pnl.toFixed(0)} | ⚡F:${fastPnlExit.toFixed(0)} 🐢S:${slowPnlExit.toFixed(0)}\nSess:${G.sessionPnL.toFixed(0)} | F:${fastRiskState} S:${slowRiskState}`);

    if(pnl < 0){
        if(fastRiskState === RS.DEFENSE){
            if(++fastDefenseLossCount >= 2){ fastCooldownStart = Date.now(); fastRiskState = RS.COOL_DOWN; sendTelegram(`🟠 FAST COOL_DOWN\nResume: ${new Date(fastCooldownStart+COOLDOWN_MS).toLocaleTimeString()}`); }
        }
        if(fastRiskState === RS.RECOVERY) fastRecoveryWinCount = 0;
    } else {
        if(fastRiskState === RS.RECOVERY && ++fastRecoveryWinCount >= 1){ fastRiskState = RS.NORMAL; fastRecoveryWinCount = fastDefenseLossCount = 0; sendTelegram("🟢 FAST NORMAL restored"); }
        if(fastRiskState === RS.DEFENSE) fastDefenseLossCount = 0;
    }

    G.position = null; G.slowLot = 0; G.fastLots = 0; G.counterLots = 0; G.slowEntryPrice = 0;
    G.avgPrice = 0; G.state = "WAIT"; G.tradeStartTime = null; G.isExiting = false;
    G.lastTradeTime = Date.now();
    fastExitSignals = 0; fastLastScalePrice = 0; weakeningCount = 0; counterEntryPrice = 0;
    isProbe = false; isProbeTrade = false; currentTradeId = null;
    slowPeakPnL = 0; // reset peak tracker for next position
    if(fastRiskState === RS.HARD_HALT) hardHaltProbeUsed = false; // probe slot resets after exit
}

function partialExit(price){
    if(G.fastLots <= 0 || G.isExiting) return;
    const dir = G.position === "LONG" ? 1 : -1;
    const pnl = (price - G.avgPrice) * dir * 1 * SYM_FAST.lot_multiplier;
    G.sessionPnL += pnl;
    G.fastPnL    += pnl; // FAST-side exit
    G.fastLots       = Math.max(0, G.fastLots - 1);
    fastLastScalePrice = price; // anchor to real market price — next scale measured from here, not avg
    fastExitSignals = 0;        // reset reversal counter — old signals shouldn't carry forward
    G.lastPartialTime = Date.now();
    logEvent({ type: "PARTIAL", price, pnl, remaining: getTotalExposure() });
    log(`💰 PARTIAL EXIT 1 mini | PnL: ${pnl.toFixed(0)} | Sess: ${G.sessionPnL.toFixed(0)} | Rem: slow:${G.slowLot} fast:${G.fastLots}`);
    sendTelegram(`💰 PARTIAL\n1 mini @ ₹${price.toFixed(2)}\nPnL: ${pnl.toFixed(0)} | Rem: ${getTotalExposure()}/10mini`);
}

function exitCounter(price){
    if(G.counterLots <= 0) return;
    const dir = G.position === "LONG" ? 1 : -1;
    const pnl = (price - counterEntryPrice) * (-dir) * G.counterLots * SYM_FAST.lot_multiplier;
    G.sessionPnL += pnl;
    G.fastPnL    += pnl; // FAST-side exit
    const holdMs = G.tradeStartTime ? Date.now() - G.tradeStartTime : 0;
    tradeLog.push({ pnl, holdMs, tag: "COUNTER" });
    logEvent({ type: "EXIT", reason: "COUNTER", price, pnl, holdMs, lots: G.counterLots });
    counterTradeCount++;
    log(`🛡 EXIT COUNTER ${G.counterLots}L @ ${price.toFixed(2)} | PnL:₹${pnl.toFixed(0)} | Sess:₹${G.sessionPnL.toFixed(0)}`);
    sendTelegram(`🛡 COUNTER EXIT\n${G.counterLots}L @ ₹${price.toFixed(2)}\nPnL:₹${pnl.toFixed(0)}`);
    G.fastLots = Math.max(0, G.fastLots - G.counterLots);
    G.counterLots = 0;
    counterEntryPrice = 0;
    fastExitSignals = 0;
    fastLastScalePrice = price;
    G.lastTradeTime = Date.now(); // prevents immediate re-counter
}

function exitFast(price, reason){
    // Exits FAST lots only — SLOW anchor remains, holding conviction position
    if(G.fastLots <= 0) return;
    const dir = G.position === "LONG" ? 1 : -1;
    const pnl = (price - G.avgPrice) * dir * G.fastLots * SYM_FAST.lot_multiplier;
    G.sessionPnL += pnl;
    G.fastPnL    += pnl; // FAST-side exit
    const holdMs = G.tradeStartTime ? Date.now() - G.tradeStartTime : 0;
    tradeLog.push({ pnl, holdMs, tag: reason });
    logEvent({ type: "EXIT", reason, price, pnl, holdMs, lots: G.fastLots });
    fastTradeCount++;
    log(`⚡ FAST EXIT [${reason}] | ${G.fastLots} mini @ ${price.toFixed(2)} | PnL:₹${pnl.toFixed(0)} | SLOW anchor:${G.slowLot} lot remains`);
    sendTelegram(`⚡ FAST EXIT [${reason}]\n${G.fastLots} mini @ ₹${price.toFixed(2)}\nPnL:₹${pnl.toFixed(0)} | Slow anchor holding`);
    G.fastLots = 0;
    if(G.counterLots > 0){ G.counterLots = 0; counterEntryPrice = 0; }
    fastExitSignals = 0; fastLastScalePrice = 0;
    // If no lots remain at all, full cleanup
    if(getTotalExposure() === 0){
        G.position = null; G.avgPrice = 0; G.state = "WAIT";
        G.tradeStartTime = null; G.lastTradeTime = Date.now();
        isProbe = false; isProbeTrade = false;
    }
}

// ─── SLOW BRAIN ───────────────────────────────────────────────────────────────
// Reads ALMA(21/55) on SLOW instrument — sets directional bias only
// Does NOT place orders — calls placeOrder for SLOW_ANCHOR when bias confirmed

function slowBrain(candles, price){
    const closes = candles.map(c => c.close);
    const s = alma(closes, SLOW_SHORT).at(-1);
    const l = alma(closes, SLOW_LONG).at(-1);

    const cross       = s > l ? 1 : s < l ? -1 : 0;
    const freshCross  = cross !== 0 && cross !== slowPrevCross;
    const trendStr    = Math.abs(s - l);
    const minTrendGap = currentATR * 0.35;
    const minSlope    = currentATR * 0.05;
    const dirStable   = slowPrevTrend === 0 || trendStr > slowPrevTrend * 0.9;
    const strongTrend = trendStr > currentATR * 0.3 && trendStr > minSlope;
    const earlyTrend  = trendStr > currentATR * 0.22 && trendStr <= currentATR * 0.35 && trendStr > minSlope && dirStable;

    // Trend weakening — computed on smoothed history
    const trendNow      = trendStr;
    const trendWeakening = slowPrevTrend > 0 && trendNow < slowPrevTrend * 0.6;

    log(`🧠 SLOW S:${s.toFixed(2)} L:${l.toFixed(2)} str:${trendStr.toFixed(2)} cross:${cross} fresh:${freshCross} weakening:${trendWeakening}`);

    // ── SET BIAS ─────────────────────────────────────────────────────────
    const NEUTRAL_COOLDOWN = 30 * 60 * 1000; // 30 min after neutral — market too unstable to trust fresh cross
    const postNeutralBlocked = G.neutralTime > 0 && (Date.now() - G.neutralTime) < NEUTRAL_COOLDOWN;
    if(postNeutralBlocked){
        const remaining = Math.ceil((NEUTRAL_COOLDOWN - (Date.now() - G.neutralTime)) / 60000);
        log(`🧠 Post-neutral cooldown (${remaining}m left) — skip bias`);
    }

    if(!postNeutralBlocked && freshCross && trendStr >= minTrendGap && (strongTrend || earlyTrend)){
        const convictionOK = trendStr > currentATR * 0.4;
        if(!convictionOK){ log(`🧠 SLOW: cross ok but conviction low (${trendStr.toFixed(2)} < ${(currentATR*0.4).toFixed(2)}) — skip`); }
        if(convictionOK){
            const newBias = cross;
            if(newBias !== G.bias){
                if(G.position && getTotalExposure() > 0){
                    const posDir = G.position === "LONG" ? 1 : -1;
                    if(newBias !== posDir){
                        log(`🔄 SLOW bias flip ${G.bias}→${newBias} — EXIT ALL`);
                        sendTelegram(`🔄 SLOW FLIP → EXIT ALL`);
                        exitAll(price, "SLOW_FLIP");
                    }
                }
                G.bias = newBias;
                G.conviction = trendStr;
                G.biasSetTime = Date.now();
                log(`🧠 SLOW → ${newBias === 1 ? "BULLISH" : "BEARISH"} bias (str:${trendStr.toFixed(2)})`);
                sendTelegram(`🧠 SLOW ${newBias===1?"🐂 BULLISH":"🐻 BEARISH"}\nStr: ${trendStr.toFixed(2)} | ATR: ${currentATR.toFixed(2)}`);
            }
        }
    }

    // ── CLEAR BIAS ON WEAKENING ──────────────────────────────────────────
    if(G.bias !== 0 && trendWeakening){
        weakeningCount++;
        log(`🧠 SLOW weakening signal ${weakeningCount}/2`);
        if(weakeningCount >= 2){
            log(`🧠 SLOW → NEUTRAL (confirmed weakening — 30m cooldown starts)`);
            G.bias = 0; G.conviction = 0; weakeningCount = 0;
            G.neutralTime = Date.now();
            sendTelegram(`🧠 SLOW → NEUTRAL\nTrend confirmed weakening\n30m cooldown before re-entry`);
        }
    } else {
        weakeningCount = 0;
    }

    // ── V2 SLOW ANCHOR — direct 1 full lot, no staging ───────────────────
    if(G.bias !== 0 && G.slowLot === 0 && G.state === "WAIT"
        && G.tradesToday < MAX_TRADES_DAY
        && Date.now() - G.lastTradeTime >= MIN_TRADE_GAP
        && getTotalExposure() < TOTAL_LOT_CAP && slowGuards()){
        const prevUnitsForSlow = getTotalExposure();
        G.slowLot = 1; // set before placeOrder so getTotalExposure is correct
        if(prevUnitsForSlow > 0) updateAvgPrice(livePrice || price, 5, true, prevUnitsForSlow);
        else G.avgPrice = livePrice || price;
        G.position = G.bias === 1 ? "LONG" : "SHORT";
        G.state = "PROBATION";
        G.tradeStartTime = G.tradeStartTime || Date.now();
        G.lastTradeTime = Date.now();
        G.slowEntryPrice = livePrice || price;
        slowEnteredThisCandle = true;
        if(currentTradeId === null) currentTradeId = `T${Date.now()}`;
        logEvent({ type: "ENTRY", subType: "SLOW_ANCHOR", direction: G.position, price: G.avgPrice, lots: 1, exposure: getTotalExposure() });
        if(!isFirst) {}; // dummy — isFirst not in scope here, handled above
        log(`🐢 V2 SLOW ANCHOR ${G.position} @ ${G.avgPrice.toFixed(2)} | exp:${getTotalExposure()}`);
        sendTelegram(`🐢 SLOW ANCHOR ${G.position}\n1 full lot @ ₹${G.avgPrice.toFixed(2)}\nExp:${getTotalExposure()}/10mini | F:${fastRiskState}`);
    }

    // ── SLOW EXIT: CONFIRMED hold until ALMA(SLOW_LONG) breach ──────────
    if(G.state === "CONFIRMED" && G.slowLot > 0){
        const buffer = previousATR > 0 && currentATR > previousATR * 1.5 ? currentATR * 0.3 : currentATR * 0.2;
        const holdingStrong = trendNow > currentATR * 0.5;
        const posDir = G.position === "LONG" ? 1 : -1;
        const breached = (posDir === 1 && price < l - buffer) || (posDir === -1 && price > l + buffer);
        if(breached && !(holdingStrong && !trendWeakening)){
            log(`🐢 SLOW structure breach — flag for exit`);
            // Don't exit immediately — let CONFIRMED logic handle it via slowExitCount
        }
    }

    // Update memory
    const currentTrend = trendStr;
    slowPrevTrend = slowPrevTrend === 0 ? currentTrend : currentTrend * 0.3 + slowPrevTrend * 0.7;
    slowPrevCross = cross;
}

// ─── FAST ENGINE ──────────────────────────────────────────────────────────────
// Reads ALMA(9/21) on FAST instrument — executes entries, scales, exits
// Only acts when G.bias !== 0

function fastEngine(candles, price, blockEarlyEntry = false, prevClose = price){
    if(blockEarlyEntry && G.state === "WAIT"){
        log("⏸ V2: pre-10am block — no new entries"); return;
    }
    if(!fastGuards()) return;
    if(currentATR * SYM_FAST.lot_multiplier < TRADE_COST * 2){ log("📏 FAST: low vol — skip"); return; }

    const closes     = candles.map(c => c.close);
    const s          = alma(closes, FAST_SHORT).at(-1);
    const l          = alma(closes, FAST_LONG).at(-1);
    const cross      = s > l ? 1 : s < l ? -1 : 0;
    const freshCross = cross !== 0 && cross !== fastPrevCross;
    const diff        = Math.abs(s - l);
    // V3: adaptive entry aggression — threshold moves with conviction
    // strong trend → lower threshold (enter earlier)
    // weak trend → higher threshold (wait for confirmation)
    const entryAggression = G.conviction > currentATR * 0.6 ? 1.3
                          : G.conviction < currentATR * 0.25 ? 0.7 : 1.0;
    const entryThresh = currentATR * 0.3 / entryAggression;
    const isStrong    = diff > entryThresh;
    const isExplosive = diff > currentATR * 0.6;
    const isWeak      = diff < currentATR * 0.15;
    const isMid       = !isStrong && !isWeak;
    const momentum    = Math.abs(price - prevClose);
    // Adaptive momentum threshold — strict in high vol, flexible in slow phases
    const momentumThresh = currentATR > 3 ? 0.25 : 0.18;
    // Trend mode — drives entry aggression and counter trade eligibility
    const trendMode   = G.conviction > currentATR * 0.5 ? "STRONG"
                      : G.conviction < currentATR * 0.25 ? "WEAK" : "NORMAL";

    log(`⚡ FAST S:${s.toFixed(2)} L:${l.toFixed(2)} diff:${diff.toFixed(2)} cross:${cross} bias:${G.bias} state:${G.state}`);

    // ── PROBE (fires when idle too long) ────────────────────────────────
    if(isProbe && G.bias !== 0 && !slowEnteredThisCandle
        && !(G.neutralTime > 0 && Date.now() - G.neutralTime < 30*60*1000)){
        if(cross === G.bias && momentum > currentATR * 0.2){
            log(`🔍 PROBE ENTRY [bias:${G.bias} mom:${momentum.toFixed(2)}]`);
            isProbeTrade = true;
            placeOrder(G.bias, 1, "PROBE");
            isProbe = false;
        } else {
            log(`🔍 Probe skipped (momentum:${momentum.toFixed(2)} < ${(currentATR*0.2).toFixed(2)} or wrong cross)`);
        }
        return;
    }

    // ── WAIT: entry logic ────────────────────────────────────────────────
    if(G.state === "WAIT"){
        const isHardHaltProbe = (fastRiskState === RS.HARD_HALT && !hardHaltProbeUsed);
        if(G.tradesToday >= MAX_TRADES_DAY
            || Date.now() - G.lastTradeTime < MIN_TRADE_GAP
            || (Date.now() - G.lastPartialTime < 300000 && G.fastLots === 0)
            || getTotalExposure() >= TOTAL_LOT_CAP
            || slowEnteredThisCandle) return; // SLOW entered this candle — wait for next

        if(G.bias === 0){ log("⏸ FAST: no SLOW bias — idle"); return; }

        // Bias maturity delay — wait 2 candles (30m) after SLOW sets bias before FAST acts
        const BIAS_DELAY  = G.conviction > currentATR * 0.5 ? 900000 : 1800000; // strong → 15m, normal → 30m
        const biasAge     = G.biasSetTime ? Date.now() - G.biasSetTime : 0;
        if(biasAge < BIAS_DELAY){ log(`⏳ Bias too fresh (${Math.round(biasAge/60000)}m < ${BIAS_DELAY/60000}m) — wait`); return; }

        // Trend exhaustion filter — avoid entering a trend that has been running > 2 hours
        const biasAgeMin = biasAge / 60000;
        // V2: trend age filter removed — bias delay handles staleness sufficiently

        // Overextension filter — avoid chasing extended moves
        // If in position: anchor to avgPrice (position context). If flat: anchor to FAST ALMA line.
        const overExtRef   = G.avgPrice > 0 ? G.avgPrice : l;
        const overextended = Math.abs(price - overExtRef) > currentATR * 2.2;
        if(overextended){ log(`🚫 Overextended (${(Math.abs(price-overExtRef)/currentATR).toFixed(2)}×ATR from ${G.avgPrice > 0 ? "avg" : "ALMA"}) — skip`); return; }

        // V2.5: entry — freshCross + strength + adaptive momentum
        // isExplosive or real-time pressure allows entry without pressure check
        if(freshCross && isStrong && cross === G.bias && momentum > currentATR * momentumThresh){
            // V3: lot size scales with conviction — strong trends get bigger initial bet
            let baseLot = G.conviction > currentATR * 0.6 ? 2 : 1;
            let fastLotSize = Math.max(1, Math.floor(baseLot * fastAllocation));
            fastLotSize = Math.min(fastLotSize, FAST_MAX_LOTS - G.fastLots);
            if(isHardHaltProbe) fastLotSize = 1; // probe always 1 mini regardless of allocation
            const pressureOK = (cross === 1 && aggressiveBuy) || (cross === -1 && aggressiveSell);
            if(isExplosive || pressureOK){
                const tag = isExplosive ? "FAST_EXPLOSIVE" : "FAST_PRESSURE";
                if(isHardHaltProbe){ log("🧪 HARD_HALT PROBE ENTRY"); hardHaltProbeUsed = true; }
                log(`⚡ ${tag} ${cross===1?"LONG":"SHORT"} | lots:${fastLotSize} diff:${diff.toFixed(2)} mode:${trendMode}`);
                placeOrder(cross, fastLotSize, tag);
            } else if(trendMode !== "WEAK"){
                if(isHardHaltProbe){ log("🧪 HARD_HALT PROBE ENTRY"); hardHaltProbeUsed = true; }
                log(`⚡ FAST_TREND ${cross===1?"LONG":"SHORT"} | lots:${fastLotSize} diff:${diff.toFixed(2)} mode:${trendMode}`);
                placeOrder(cross, fastLotSize, "FAST_TREND");
            } else {
                log(`⏸ FAST: WEAK mode without pressure — skip`);
            }
        } else if(isWeak && cross === 0 && G.bias !== 0){
            // Fade mode — only in pure sideways, direction against extended move
            const fadeThresh = previousATR > 0 && currentATR > previousATR * 1.5
                ? currentATR * 0.6 : currentATR * 0.4;
            const dir = price > s + fadeThresh ? -1 : price < s - fadeThresh ? 1 : 0;
            if(dir !== 0 && dir === G.bias){
                log(`⚡ FAST FADE ${dir===1?"LONG":"SHORT"}`);
                placeOrder(dir, 1, "FAST_FADE");
            }
        } else if(isMid){
            log(`⏸ FAST: mid zone (diff:${diff.toFixed(2)}) — no trade`);
        } else if(cross !== 0 && G.position !== null && cross === G.bias
                  && G.fastLots < FAST_MAX_LOTS
                  && getTotalExposure() < TOTAL_LOT_CAP){
            // Only scale in profit — pyramiding style, not martingale
            if(fastRiskState === RS.HARD_HALT){ log("⚠ FAST HARD_HALT — no scaling"); return; }
            if(calculatePnL(price) <= 0){ log("⏸ Scale blocked — position not in profit"); }
            else {
                // trendMode drives aggression — STRONG trends scale faster
                const aggression = trendMode === "STRONG" ? 1.8
                                 : trendMode === "WEAK"   ? 0.6 : 1.0;
                const scaleBase  = trendMode === "WEAK" ? 0.5 : 0.3;
                if(Math.abs(price - fastLastScalePrice) > currentATR * scaleBase / aggression){
                    const scaleLot = fastAllocation >= 1.0 ? 1 : 0; // no scaling in DEFENSE or worse
                    if(scaleLot > 0){
                        log(`⚡ FAST SCALE +1 (${G.fastLots+1}/${FAST_MAX_LOTS} mode:${trendMode} alloc:${fastAllocation})`);
                        fastLastScalePrice = price;
                        placeOrder(cross, scaleLot, "FAST_SCALE");
                    } else {
                        log(`⏸ Scale blocked — fastAllocation:${fastAllocation} (${fastRiskState})`);
                    }
                }
            }
        }
    }

    // ── PROBATION ────────────────────────────────────────────────────────
    // V2: price-movement based — confirm on +0.2×ATR, stop on -0.3×ATR, hold otherwise
    else if(G.state === "PROBATION"){
        const posDir  = G.position === "LONG" ? 1 : -1;
        const pnlMove = (price - G.avgPrice) * posDir;
        const stopMult = (fastRiskState === RS.HARD_HALT) ? 0.2 : 0.3; // tighter stop on probe
        if(pnlMove < -(currentATR * stopMult)){
            log(`❌ PROBATION stop (${(pnlMove/currentATR).toFixed(2)}×ATR stopMult:${stopMult})`);
            exitFast(price, "PROBATION_STOP");
        } else if(pnlMove > currentATR * 0.2){
            log(`✅ CONFIRMED — moved ${(pnlMove/currentATR).toFixed(2)}×ATR in favor`);
            G.state = "CONFIRMED";
        } else {
            log(`⏳ PROBATION holding (move:${pnlMove.toFixed(2)} need ±${(currentATR*0.2).toFixed(2)})`);
        }
    }

    // ── CONFIRMED ────────────────────────────────────────────────────────
    else if(G.state === "CONFIRMED"){
        if(Date.now() - G.tradeStartTime > MAX_TRADE_DUR){ log("⏱ Expired"); exitAll(price, "EXPIRED"); return; }

        // Minimum hold — don't exit on first candle noise
        const held = G.tradeStartTime ? Date.now() - G.tradeStartTime : 0;
        if(held < MIN_HOLD){ log(`⏳ Hold guard (${Math.round(held/60000)}m < 5m)`); return; }

        const posDir  = G.position === "LONG" ? 1 : -1;
        const biasAge = G.biasSetTime ? ((Date.now() - G.biasSetTime) / 60000).toFixed(0) : "?";
        log(`📦 Pos:${G.position} | Avg:${G.avgPrice.toFixed(2)} | Exp:${getTotalExposure()} | BiasAge:${biasAge}m`);

        // Structure stop first: market has technically invalidated the trade
        const maxMove    = currentATR * 2.5;
        const currentPnL = calculatePnL(price);
        if(Math.abs(price - G.avgPrice) > maxMove){
            log(`🛑 Structure stop (${(Math.abs(price-G.avgPrice)/currentATR).toFixed(1)}×ATR | ₹${currentPnL.toFixed(0)})`);
            exitAll(price, "STRUCTURE_STOP"); return;
        }
        // Capital stop: 1% of capital — rupee-based, catches position-sized risk
        const MAX_TRADE_LOSS_RUPEES = CAPITAL * 0.006; // 0.6% — tighter than 1%, saves bad trades early
        if(currentPnL < -MAX_TRADE_LOSS_RUPEES){
            log(`🛑 Capital stop ₹${MAX_TRADE_LOSS_RUPEES} | actual:₹${currentPnL.toFixed(0)}`);
            exitAll(price, "MAX_LOSS"); return;
        }

        // SLOW bias flip → immediate full exit
        if(G.bias !== 0 && G.bias !== posDir){
            log("🔄 Bias conflict in CONFIRMED — exit ALL");
            exitAll(price, "BIAS_FLIP"); return;
        }

        // SLOW bias cleared (trend weakened) → reduce exposure, don't panic exit
        // FAST exits (risk reduced), SLOW holds (long-term conviction still valid)
        if(G.bias === 0){
            log("🧠 SLOW bias cleared — exit FAST only, SLOW holds");
            if(G.fastLots > 0) exitFast(price, "BIAS_CLEAR");
            // Keep SLOW anchor alive but downgrade confidence — re-evaluate next candle
            G.state = G.slowLot > 0 ? "PROBATION" : "WAIT";
            return;
        }

        // Scale aging: if holding 3+ fast lots for > 45 min, reduce exposure
        if(G.fastLots >= 3 && held > 45 * 60 * 1000){
            log(`⚠ Scale aging — ${G.fastLots} fast lots held ${Math.round(held/60000)}m — reducing`);
            partialExit(price);
        }

        // Probe quick exit — probe is FAST-only
        if(isProbeTrade && Math.abs(price - G.avgPrice) > currentATR * 0.8){
            log("⚡ Probe exit"); exitFast(price, "PROBE_EXIT"); return;
        }

        // Trailing profit lock: if session is up 0.5%+ and trade pulls back > 1 ATR worth of mini
        const LOCK_PROFIT = CAPITAL * 0.005;
        if(G.sessionPnL > LOCK_PROFIT && currentPnL < -(currentATR * SYM_FAST.lot_multiplier)){
            log(`🔒 Profit lock — sess:₹${G.sessionPnL.toFixed(0)} trade:₹${currentPnL.toFixed(0)}`);
            exitFast(price, "PROFIT_LOCK"); return;
        }

        // ── COUNTER TRADE ENTRY ───────────────────────────────────────────
        if(fastRiskState === RS.HARD_HALT) return; // no counter during FAST HARD_HALT
        // STRONG mode = no counter — don't fight high-conviction trends
        const stretched = Math.abs(price - G.avgPrice) > currentATR * 1.2;
        if(!isProbe && G.slowLot > 0 && cross !== 0 && cross !== G.bias
            && isStrong && trendMode === "WEAK" && stretched   // key change: stretched + WEAK mode
            && G.counterLots < 2 && G.avgPrice > 0
            && G.fastLots <= 2
            && (Date.now() - G.biasSetTime) > 30 * 60 * 1000
            && (Date.now() - G.lastTradeTime) > 5 * 60 * 1000
            && ((G.bias === 1 && price < l) || (G.bias === -1 && price > l))
            && !(aggressiveBuy || aggressiveSell)
            && Math.abs(price - fastLastScalePrice) < currentATR * 1.2
            && getTotalExposure() < TOTAL_LOT_CAP
        ){
            log(`🛡 COUNTER ${cross===1?"LONG":"SHORT"} | stretch:${(Math.abs(price-G.avgPrice)/currentATR).toFixed(2)}×ATR | mode:${trendMode}`);
            counterEntryPrice = price;
            placeOrder(cross, 1, "FAST_COUNTER");
        }

        // Counter trade quick exit — target 0.6×ATR profit, hard stop 0.4×ATR loss
        // Counter trades are short-duration only — exit fast, don't let them run
        if(G.counterLots > 0 && counterEntryPrice > 0){
            const counterDir  = -posDir;
            const counterMove = (price - counterEntryPrice) * counterDir;
            if(counterMove > currentATR * 0.6){
                log(`🛡 Counter profit exit (${(counterMove/currentATR).toFixed(2)}×ATR)`);
                exitCounter(price); return;
            }
            if(counterMove < -(currentATR * 0.4)){
                log(`🛡 Counter stop (${(counterMove/currentATR).toFixed(2)}×ATR)`);
                exitCounter(price); return;
            }
        }

        // Reversal confirmation — exits FAST only, SLOW anchor holds
        if(cross === -posDir){
            fastExitSignals++;
            const slowPnlNow       = calculateSplitPnL(price).slow;
            const giveBack         = slowPeakPnL - slowPnlNow;
            const giveBackTrigger  = currentATR * SYM_SLOW.lot_multiplier * 1.2;
            const weakeningMove    = Math.abs(price - fastPrevAlmaLong) > currentATR * 0.5;

            if(G.slowLot > 0 && slowPeakPnL > 0 && weakeningMove){
                if(giveBack > giveBackTrigger * 1.8){
                    // Stage 2 — deep giveback: protect SLOW profit, exit everything
                    log(`🔒 STAGE 2 SLOW PROTECT | giveBack:₹${giveBack.toFixed(0)} peak:₹${slowPeakPnL.toFixed(0)}`);
                    sendTelegram(`🔒 SLOW PROFIT LOCK\nGiveback:₹${giveBack.toFixed(0)} (${(giveBack/giveBackTrigger).toFixed(1)}× trigger)\nPeak:₹${slowPeakPnL.toFixed(0)}`);
                    exitAll(price, "SLOW_PROTECT"); return;
                } else if(giveBack > giveBackTrigger && G.fastLots > 0){
                    // Stage 1 — moderate giveback: FAST exits, SLOW holds
                    log(`🛡 STAGE 1 FAST PROTECT | giveBack:₹${giveBack.toFixed(0)} trigger:₹${giveBackTrigger.toFixed(0)}`);
                    exitFast(price, "PROTECT_SLOW"); return;
                }
            }

            log(`⚠ Reversal signal ${fastExitSignals}/2 | PnL:₹${currentPnL.toFixed(0)} giveBack:₹${giveBack.toFixed(0)}`);
            if(fastExitSignals >= 1 && currentPnL < 0){ log("🔄 Reversal + losing — FAST exit"); exitFast(price, "REVERSAL"); return; }
            if(fastExitSignals >= 2){ log("🔄 Confirmed reversal — FAST exit"); exitFast(price, "REVERSAL"); return; }
        } else { fastExitSignals = 0; }

        // Adaptive profit target — books FAST gains, SLOW holds
        // V3: exit intelligence — target adapts to current trend strength
        const exitAggression = diff > currentATR * 0.6 ? 1.3
                             : diff < currentATR * 0.2 ? 0.7 : 1.0;
        const profitTarget   = currentATR * 1.0 * exitAggression;
        log(`📐 Exit target: ${profitTarget.toFixed(2)} (exitAggr:${exitAggression} diff:${diff.toFixed(2)})`);
        const move = Math.abs(price - G.avgPrice);
        if(move > profitTarget){
            const isStrongNow = diff > currentATR * 0.6;
            if(isStrongNow && G.fastLots > 1){
                partialExit(price);
            } else if(G.fastLots > 0) {
                log(`⚡ Adaptive exit FAST (${(move/currentATR).toFixed(2)}×ATR)`);
                exitFast(price, "PROFIT_TARGET");
            }
        }
    }

    fastPrevAlmaLong = l;
    fastPrevCross    = cross;
}

// ─── UNIFIED STRATEGY LOOP ────────────────────────────────────────────────────
// Fetches candles for both instruments, runs SLOW then FAST each 15m candle

async function strategyLoop(){
    if(loopRunning) return; loopRunning = true;
    try{
        const now = new Date();
        if(now.getHours() < 9 || now.getHours() >= 23) return;
        if((now.getMinutes() - 1) % 15 !== 0) return;
        const slot = Math.floor(Date.now() / 900000);
        if(slot === lastCandleExecuted) return;
        lastCandleExecuted = slot;
        candleTradeLock = false;
        slowEnteredThisCandle = false;
        log(`🕯 15m @ ${now.toLocaleTimeString()}`);

        const fastFrom = new Date(now.getTime() - 1000*60*15*220);  // 15m × 220 candles
        const slowFrom = new Date(now.getTime() - 1000*60*60*120);  // 1H × 120 candles

        // SLOW on 1H (stable bias), FAST on 15m (execution precision)
        const [slowCandles, fastCandles] = await Promise.all([
            SYM_SLOW.instrument_token > 0
                ? kc.getHistoricalData(SYM_SLOW.instrument_token, "60minute", slowFrom, now)
                : Promise.resolve([]),
            kc.getHistoricalData(SYM_FAST.instrument_token, INTERVAL, fastFrom, now)
        ]);

        if(fastCandles.length < SLOW_LONG + 5){ log(`⚠ Insufficient candles: ${fastCandles.length}`); return; }

        const price     = livePrice || fastCandles.at(-1).close;
        const prevClose = fastCandles.at(-2)?.close || price; // for momentum filter

        // ATR from fast instrument
        previousATR = currentATR;
        currentATR  = smoothATR(calcATR(fastCandles));
        updateATR(currentATR);
        if(currentATR > peakATR) peakATR = currentATR;

        if(!sessionStartLogged && currentATR > 0){
            sessionStartLogged = true;
            const initMode = currentATR > 5 ? "HIGH VOL" : currentATR > 2.5 ? "NORMAL" : "LOW VOL";
            sendTelegram(`📊 Market Context\nATR: ${currentATR.toFixed(2)} | Mode: ${initMode}\nSLOW ALMA(${SLOW_SHORT}/${SLOW_LONG}) FAST ALMA(${FAST_SHORT}/${FAST_LONG})`);
        }

        log(`📊 P:${price.toFixed(2)} | ATR:${currentATR.toFixed(2)} | bias:${G.bias} conv:${G.conviction.toFixed(2)} | slow:${G.slowLot} fast:${G.fastLots} exp:${getTotalExposure()}/10 | 💰 Sess:${G.sessionPnL.toFixed(0)} ⚡F:${G.fastPnL.toFixed(0)} 🐢S:${G.slowPnL.toFixed(0)} | F:${fastRiskState} S:${slowRiskState}`);

        if(currentATR < 0.05){ log("⚠ ATR too low — dead market"); return; }

        // Vol spike → cooldown
        if(previousATR > 0 && fastRiskState !== RS.COOL_DOWN && currentATR > previousATR * 2.5){
            fastCooldownCandles = 1; fastRiskState = RS.COOL_DOWN;
            log(`⚡ VolSpike→CD`); sendTelegram(`⚡ Spike→CD\nATR ${currentATR.toFixed(2)}`);
        }

        // Stagnation probe
        if(G.state === "WAIT"){
            candlesWithoutTrade++;
            if(fastRiskState === RS.NORMAL && G.bias !== 0 && candlesWithoutTrade >= STAGNATION_LIM){
                isProbe = true; candlesWithoutTrade = 0;
                log(`🔍 Probe — idle ${STAGNATION_LIM} candles`);
                sendTelegram(`🔍 Probe firing`);
            }
        } else { candlesWithoutTrade = 0; }

        evaluateFastRisk();
        updateFastAllocation();
        evaluateSlowRisk();

        const blockEarlyEntry = now.getHours() < 10;
        const slowData = slowCandles.length >= SLOW_LONG + 5 ? slowCandles : fastCandles;

        // SLOW always runs — independent of FAST risk state
        slowBrain(slowData, price);

        // FAST only when not halted or cooling down
        const allowFast = !(fastRiskState === RS.HARD_HALT || fastRiskState === RS.COOL_DOWN);
        if(allowFast){
            fastEngine(fastCandles, price, blockEarlyEntry, prevClose);
        } else {
            log(`⏸ FAST blocked [${fastRiskState}] — SLOW running independently`);
        }

    }finally{ loopRunning = false; }
}

setInterval(() => strategyLoop().catch(err => log("ERR: " + err.message)), 1000);

function sendDashboard(){
    sendTelegram(
        `📊 LIVE DASHBOARD\n\n` +
        `⚡ FAST:  ₹${G.fastPnL.toFixed(0)}\n` +
        `🐢 SLOW:  ₹${G.slowPnL.toFixed(0)}\n` +
        `💰 TOTAL: ₹${G.sessionPnL.toFixed(0)}\n\n` +
        `📦 Pos: ${G.position || "NONE"}\n` +
        `⚡ FAST lots: ${G.fastLots}\n` +
        `🐢 SLOW lots: ${G.slowLot}\n\n` +
        `🧠 Bias: ${G.bias === 1 ? "BULLISH" : G.bias === -1 ? "BEARISH" : "NEUTRAL"}\n` +
        `⚙ FAST: ${fastRiskState} (alloc:${fastAllocation})\n` +
        `⚙ SLOW: ${slowRiskState}`
    );
}
// Auto-send dashboard every 30 min when in position
setInterval(() => { if(G.position) sendDashboard(); }, 1800000);

// ─── LIFECYCLE ────────────────────────────────────────────────────────────────
setInterval(() => {
    const now = new Date();
    if(now.getHours() === 23 && now.getMinutes() === 0 && !lifecycleClosed){
        lifecycleClosed = true;
        if(G.position){ log("🔔 23:00 FORCE CLOSE ALL"); exitAll(livePrice || G.avgPrice, "EOD"); }
        sendTelegram("🕚 All positions closed (EOD 23:00)");
    }
    if(now.getHours() === 23 && now.getMinutes() === 15 && !lifecycleShutdown){
        lifecycleShutdown = true;
        log("📴 Shutdown");
        const endTime  = new Date();
        const duration = Math.round((endTime - startTime) / 60000);

        // Session analytics
        const pnls    = tradeLog.map(t => t.pnl);
        const best    = pnls.length ? Math.max(...pnls) : 0;
        const worst   = pnls.length ? Math.min(...pnls) : 0;
        const avgHold = tradeLog.length
            ? Math.round(tradeLog.reduce((s, t) => s + t.holdMs, 0) / tradeLog.length / 60000)
            : 0;

        // Session quality tag
        const sessionType = G.tradesToday <= 2 && G.sessionPnL > 0 ? "🟢 CLEAN"
            : G.tradesToday > 5 && Math.abs(G.sessionPnL) < 500 ? "🟡 CHOPPY"
            : peakATR > currentATR * 1.8 ? "🔴 VOLATILE"
            : G.sessionPnL > 0 ? "🟢 POSITIVE" : "🔴 NEGATIVE";

        // Market mode at start vs end
        const marketMode = peakATR > 5 ? "HIGH VOL" : peakATR > 2.5 ? "NORMAL" : "LOW VOL";

        sendTelegram(
            `📊 V3 Session Closed\n` +
            `📅 ${endTime.toLocaleDateString("en-IN", {weekday:"long", day:"2-digit", month:"short", year:"numeric"})}\n` +
            `🕐 ${startTime.toLocaleTimeString()} → ${endTime.toLocaleTimeString()} (${duration}m)\n\n` +
            `💰 TOTAL: ₹${G.sessionPnL.toFixed(0)}\n` +
            `⚡ FAST:  ₹${G.fastPnL.toFixed(0)}\n` +
            `🐢 SLOW:  ₹${G.slowPnL.toFixed(0)}\n` +
            `📦 Trades: ${G.tradesToday}\n\n` +
            `🏆 Best:  ₹${best.toFixed(0)}\n` +
            `💀 Worst: ₹${worst.toFixed(0)}\n\n` +
            `⚡ FAST:    ${fastTradeCount}\n` +
            `🧠 SLOW:    ${slowTradeCount}\n` +
            `🛡 COUNTER: ${counterTradeCount}\n\n` +
            `⏱ Avg Hold: ${avgHold}m\n` +
            `📊 Peak ATR: ${peakATR.toFixed(2)} | Mode: ${marketMode}\n` +
            `📊 Session: ${sessionType}\n` +
            `⚙ Fast: ${fastRiskState} | Slow: ${slowRiskState}`
        );
        setTimeout(() => process.exit(0), 2000);
    }
}, 30000);
