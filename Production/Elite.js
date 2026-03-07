// ==========================================================
// ELITE HYBRID ENGINE – FINAL STABLE ARCHITECTURE 
// Strategy / Risk / Lifecycle fully separated
// Risk States: NORMAL → DEFENSE → COOL_DOWN → RECOVERY → HARD_HALT
// ==========================================================

require("dotenv").config();

const { KiteConnect, KiteTicker } = require("kiteconnect");
const axios = require("axios");
const fs = require("fs");

// ================= TELEGRAM =================

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(message){
    if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    try{
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            { chat_id: TELEGRAM_CHAT_ID, text: message }
        );
    }catch(err){
        console.log("Telegram Error");
    }
}

// ================= ACCESS TOKEN =================

const ACCESS_FILE_PATH = "access_code.txt";
const ACCESS_TOKEN = fs.readFileSync(ACCESS_FILE_PATH,"utf8").trim();
const tokenStats = fs.statSync(ACCESS_FILE_PATH);
const tokenDate = new Date(tokenStats.mtime).toLocaleString();

function startupHealthCheck(){
    let health = [];
    health.push("🩺 Startup Health Check");
    health.push(process.env.API_KEY ? "✅ API Key Loaded" : "❌ API Key Missing");
    health.push(ACCESS_TOKEN ? "✅ Access Token Loaded" : "❌ Access Token Missing");
    health.push(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID
        ? "✅ Telegram Configured"
        : "⚠ Telegram Not Configured");
    health.push(`🕒 Token Date: ${tokenDate}`);
    return health.join("\n");
}

// ================= CONFIG =================

const API_KEY = process.env.API_KEY;

const SYMBOL = {
    tradingsymbol: "ZINC26MARFUT",
    exchange: "MCX",
    instrument_token: 124841479
};

const INTERVAL = "15minute";
const ALMA_LENGTH = 20;
const ALMA_OFFSET = 0.85;
const ALMA_SIGMA = 6;
const EMA_LENGTH = 20;
const ATR_LENGTH = 14;
const LOT_MULTIPLIER = 5000;

const CAPITAL = 500000;
const MAX_LOTS = 4;
const BASE_DAILY_RISK = 0.03;
const TRAIL_DD_PERCENT = 0.06;
const RISK_PER_TRADE_PERCENT = 0.005;

// ================= RISK STATE MACHINE =================
//
// NORMAL      – Full lot logic, scaling allowed, standard thresholds
// DEFENSE     – Lot=1, no scaling, slope 1.5x, ATR expansion ≥10% required
// COOL_DOWN   – No entries for 60 min (absolute timestamp), indicators compute
// RECOVERY    – Lot=1, standard slope, no scaling; 2 clean wins → NORMAL
// HARD_HALT   – Max daily DD or trailing DD breached; no trading, session over
//
// Transitions (checked only on 15m boundary):
//   NORMAL    → DEFENSE   : sessionPnL ≤ -1% capital
//   DEFENSE   → COOL_DOWN : 2 consecutive losses inside DEFENSE
//   COOL_DOWN → DEFENSE   : cooldown timer (60 min) expired (absolute timestamp)
//   DEFENSE   → RECOVERY  : sessionPnL > -0.25% capital (gradual recovery)
//   RECOVERY  → DEFENSE   : sessionPnL ≤ -0.25% capital (slipped back)
//   RECOVERY  → NORMAL    : 2 consecutive profitable trades in RECOVERY
//   Any       → HARD_HALT : max daily DD OR trailing DD breached (irrevocable)
//
// Lot rules:
//   NORMAL    → calculateLot() + confirmation bump + in-trade scaling
//   DEFENSE   → locked at 1 (entry, confirmation bump skipped, no scaling)
//   RECOVERY  → locked at 1 (entry, confirmation bump skipped, no scaling)
//   COOL_DOWN → no entries
//   HARD_HALT → no entries
//
// ============================================================

const RISK_STATE = {
    NORMAL    : "NORMAL",
    DEFENSE   : "DEFENSE",
    COOL_DOWN : "COOL_DOWN",
    RECOVERY  : "RECOVERY",
    HARD_HALT : "HARD_HALT"
};

let riskState = RISK_STATE.NORMAL;

// Cooldown: absolute timestamp set once, never recalculated per cycle
let cooldownStartTime = null;
const COOLDOWN_DURATION_MS = 60 * 60 * 1000; // 60 minutes

// Consecutive loss counter scoped to DEFENSE mode only
let defenseLossCount = 0;

// Clean-win counter scoped to RECOVERY mode only
let recoveryWinCount = 0;


// ================= STATE =================

let kc = new KiteConnect({ api_key: API_KEY });
kc.setAccessToken(ACCESS_TOKEN);

let equityHigh = CAPITAL;
let isExiting = false;
let position = null;
let lotSize = 0;
let state = "WAIT";
let entryPrice = 0;
let sessionPnL = 0;
let pullbackCount = 0;
let previousSlope = 0;
let currentATR = 0;
let livePrice = 0;

let previousATR = 0;  // tracks last candle's ATR for expansion filter
let lastCandleExecuted = null;
let lifecycleClosed = false;
let lifecycleShutdown = false;

let tradeStartTime = null;
const MAX_TRADE_DURATION = 90 * 60 * 1000; // 90 minutes
// ================= LOG =================

function log(msg){
    console.log(`[${new Date().toLocaleTimeString()}] [${riskState}] ${msg}`);
}

// ================= RISK STATE TRANSITIONS =================

/**
 * Called once per 15m boundary BEFORE decisionEngine.
 * Evaluates and transitions riskState based on current session metrics.
 * HARD_HALT is also checked here (and inside propGuards for tick-level safety).
 */
function evaluateRiskState(){

    const equity = CAPITAL + sessionPnL;
    equityHigh = Math.max(equityHigh, equity);

    // ── HARD HALT checks (highest priority, irrevocable) ──────────────────
    const fixedBase = CAPITAL * BASE_DAILY_RISK;
    const floor = fixedBase * 0.5;
    const adaptive = fixedBase * (currentATR / 10);
    const dailyLimit = Math.max(floor, adaptive);
    const trailDD = CAPITAL * TRAIL_DD_PERCENT;
    
    
    const volatilitySpike = currentATR > previousATR * 1.6;

    if(volatilitySpike){
       cooldownStartTime = Date.now();
       riskState = RISK_STATE.COOL_DOWN;
       log("⚡ Volatility Spike → COOL_DOWN");
       sendTelegram("⚡ Volatility spike detected → Entering cooldown");
       return;
    }
    
    if(sessionPnL < -dailyLimit || (equityHigh - equity) >= trailDD){
        if(riskState !== RISK_STATE.HARD_HALT){
            riskState = RISK_STATE.HARD_HALT;
            log("🔴 HARD HALT: DD limit breached");
            sendTelegram(
                `🔴 HARD HALT\n` +
                `SessionPnL: ${sessionPnL.toFixed(0)}\n` +
                `Reason: ${sessionPnL <= -dailyLimit ? "Daily Limit" : "Trailing DD"}`
            );
        }
        return;
    }

    // ── COOL_DOWN expiry check ─────────────────────────────────────────────
    if(riskState === RISK_STATE.COOL_DOWN){
        const elapsed = Date.now() - cooldownStartTime;
        if(elapsed >= COOLDOWN_DURATION_MS){
            riskState = RISK_STATE.DEFENSE;
            previousATR = currentATR;
            defenseLossCount = 0; // fresh slate entering DEFENSE after cooldown
            log("🟡 COOL_DOWN expired → DEFENSE");
            sendTelegram("🟡 Cooldown Complete → Returning to DEFENSE mode");
        }
        // still cooling down — no further transitions
        return;
    }

    // ── NORMAL → DEFENSE ──────────────────────────────────────────────────
    if(riskState === RISK_STATE.NORMAL){
        const defenseThreshold = -(CAPITAL * 0.01); // -1% equity
        if(sessionPnL <= defenseThreshold){
            riskState = RISK_STATE.DEFENSE;
            defenseLossCount = 0;
            log("🟡 Entering DEFENSE: sessionPnL crossed -1%");
            sendTelegram(
                `🟡 DEFENSE MODE\n` +
                `SessionPnL: ${sessionPnL.toFixed(0)}\n` +
                `Lot capped at 1, slope filter 1.5x`
            );
        }
        return;
    }

    // ── DEFENSE → COOL_DOWN or DEFENSE → RECOVERY ─────────────────────────
    if(riskState === RISK_STATE.DEFENSE){

        // Promote to RECOVERY once session recovers to within -0.25% of capital.
        // Using > 0 is too strict — churning small wins/losses can trap the engine
        // permanently in DEFENSE even when the session is clearly recovering.
        const recoveryThreshold = -(CAPITAL * 0.0025); // -0.25%
        if(sessionPnL > recoveryThreshold){
            riskState = RISK_STATE.RECOVERY;
            recoveryWinCount = 0;
            log("🔵 DEFENSE → RECOVERY: session PnL above -0.25% threshold");
            sendTelegram(
                `🔵 RECOVERY MODE\n` +
                `SessionPnL: ${sessionPnL.toFixed(0)}\n` +
                `Need 2 clean wins to return to NORMAL`
            );
        }
        // DEFENSE → COOL_DOWN handled inside exitPosition when defenseLossCount >= 2
        return;
    }

    // ── RECOVERY → NORMAL ─────────────────────────────────────────────────
    if(riskState === RISK_STATE.RECOVERY){
        // Transition to NORMAL handled inside exitPosition when recoveryWinCount >= 2
        // Guard: if session dips back below -0.25%, return to DEFENSE
        const recoveryThreshold = -(CAPITAL * 0.0025);
        if(sessionPnL <= recoveryThreshold){
            riskState = RISK_STATE.DEFENSE;
            defenseLossCount = 0;
            log("🟡 RECOVERY → DEFENSE: session PnL fell below -0.25% again");
            sendTelegram(`🟡 RECOVERY stalled → Back to DEFENSE\nSessionPnL: ${sessionPnL.toFixed(0)}`);
        }
        return;
    }
}

// ================= WEBSOCKET =================

const ticker = new KiteTicker({
    api_key: API_KEY,
    access_token: ACCESS_TOKEN
});

ticker.connect();

ticker.on("connect", () => {
    ticker.subscribe([SYMBOL.instrument_token]);
    ticker.setMode(ticker.modeFull, [SYMBOL.instrument_token]);
    log("WebSocket Connected");
    sendTelegram(
        `🟢 Elite Bot Started\n` +
        `📅 Token Date: ${tokenDate}\n` +
        `💰 SessionPnL: ${sessionPnL}\n` +
        `⚙ Risk State: ${riskState}\n\n` +
        startupHealthCheck()
    );
});

ticker.on("ticks", (ticks) => {

    if(riskState === RISK_STATE.HARD_HALT) return;
    if(!ticks.length) return;

    livePrice = ticks[0].last_price;

    if(position  && currentATR && !isExiting){

        const spike = Math.abs(livePrice - entryPrice);
        const trapThreshold = currentATR * 0.8;

        if(spike > trapThreshold){
            log(`⚠ Trap Exit @ ${livePrice}`);
            sendTelegram(`⚠ TRAP EXIT @ ${livePrice}`);
            exitPosition(livePrice);
        }
    }
});

// ================= INDICATORS =================

function heikinAshi(data){
    let ha=[];
    for(let i=0;i<data.length;i++){
        let c=data[i];
        if(i===0){
            ha.push({
                open:(c.open+c.close)/2,
                close:(c.open+c.high+c.low+c.close)/4
            });
        }else{
            ha.push({
                open:(ha[i-1].open+ha[i-1].close)/2,
                close:(c.open+c.high+c.low+c.close)/4
            });
        }
    }
    return ha;
}

function ema(values,length){
    let result=[];
    let k=2/(length+1);
    let prev=values[0];
    result.push(prev);
    for(let i=1;i<values.length;i++){
        let cur=values[i]*k+prev*(1-k);
        result.push(cur);
        prev=cur;
    }
    return result;
}

function alma(values){
    const m=ALMA_OFFSET*(ALMA_LENGTH-1);
    const s=ALMA_LENGTH/ALMA_SIGMA;
    let result=[];
    for(let i=ALMA_LENGTH-1;i<values.length;i++){
        let sum=0,norm=0;
        for(let j=0;j<ALMA_LENGTH;j++){
            let w=Math.exp(-((j-m)**2)/(2*s*s));
            sum+=values[i-ALMA_LENGTH+1+j]*w;
            norm+=w;
        }
        result.push(sum/norm);
    }
    return result;
}

function atr(data){
    let trs=[];
    for(let i=1;i<data.length;i++){
        let high=data[i].high;
        let low=data[i].low;
        let prevClose=data[i-1].close;
        let tr=Math.max(high-low,Math.abs(high-prevClose),Math.abs(low-prevClose));
        trs.push(tr);
    }
    return trs.slice(-ATR_LENGTH).reduce((a,b)=>a+b,0)/ATR_LENGTH;
}

function calculateLot(){
    const riskCapital = CAPITAL * RISK_PER_TRADE_PERCENT;
    const riskPerLot = currentATR * LOT_MULTIPLIER;
    let lots = Math.floor(riskCapital / riskPerLot);
    return Math.max(1, Math.min(lots, MAX_LOTS));
}

// ================= RISK GATE =================

/**
 * Per-candle gate. Only blocks on HARD_HALT and COOL_DOWN.
 * All other state logic is handled by evaluateRiskState().
 */
function propGuards(){

    if(riskState === RISK_STATE.HARD_HALT){
        log("Guard: HARD HALT active");
        return false;
    }

    if(riskState === RISK_STATE.COOL_DOWN){
        const remaining = Math.ceil(
            (COOLDOWN_DURATION_MS - (Date.now() - cooldownStartTime)) / 60000
        );
        log(`Guard: COOL_DOWN active – ${remaining}m remaining`);
        return false;
    }

    return true;
}

// ================= EXIT =================

function exitPosition(price){

    if(isExiting) return;
    isExiting = true;

    let pnl = position === "LONG"
        ? (price - entryPrice)
        : (entryPrice - price);

    pnl *= lotSize * LOT_MULTIPLIER;
    sessionPnL += pnl;

    log(`EXIT ${position} ${lotSize} | TradePnL: ${pnl.toFixed(0)} | Session: ${sessionPnL.toFixed(0)}`);

    sendTelegram(
        `❌ EXIT ${position}\n` +
        `Lots: ${lotSize}\n` +
        `Price: ${price.toFixed(2)}\n` +
        `TradePnL: ${pnl.toFixed(0)}\n` +
        `SessionPnL: ${sessionPnL.toFixed(0)}\n` +
        `RiskState: ${riskState}`
    );

    // ── Post-trade risk state bookkeeping ─────────────────────────────────

    if(pnl < 0){

        if(riskState === RISK_STATE.DEFENSE){
            defenseLossCount++;
            log(`DEFENSE loss count: ${defenseLossCount}`);

            if(defenseLossCount >= 2){
                // Absolute timestamp – set once, never recalculated
                cooldownStartTime = Date.now();
                riskState = RISK_STATE.COOL_DOWN;
                log("🟠 DEFENSE → COOL_DOWN: 2 consecutive losses in DEFENSE");
                sendTelegram(
                    `🟠 COOL_DOWN ACTIVATED\n` +
                    `2 consecutive losses in DEFENSE\n` +
                    `No entries for 60 minutes\n` +
                    `Resume at: ${new Date(cooldownStartTime + COOLDOWN_DURATION_MS).toLocaleTimeString()}`
                );
            }
        }

        if(riskState === RISK_STATE.RECOVERY){
            // A loss in RECOVERY resets the win counter
            recoveryWinCount = 0;
            log("RECOVERY win streak reset by loss");
        }

    } else {

        if(riskState === RISK_STATE.RECOVERY){
            recoveryWinCount++;
            log(`RECOVERY clean win: ${recoveryWinCount}/2`);

            if(recoveryWinCount >= 2){
                riskState = RISK_STATE.NORMAL;
                recoveryWinCount = 0;
                defenseLossCount = 0;
                log("🟢 RECOVERY → NORMAL: 2 clean wins achieved");
                sendTelegram(
                    `🟢 BACK TO NORMAL\n` +
                    `2 clean wins in RECOVERY\n` +
                    `Full lot logic and scaling restored`
                );
            }
        }

        if(riskState === RISK_STATE.DEFENSE){
            // A profitable trade in DEFENSE resets the consecutive loss counter
            // (transition to RECOVERY is handled by evaluateRiskState on next candle)
            defenseLossCount = 0;
        }
    }

    // ── Reset trade state ─────────────────────────────────────────────────
    position = null;
    lotSize = 0;
    state = "WAIT";
    pullbackCount = 0;
    tradeStartTime = null;
    isExiting = false;
}

// ================= STRATEGY =================

function decisionEngine(price, almaHigh, almaLow, emaSlope){

    if(!propGuards()) return;

    log(`State: ${state} | Price: ${price.toFixed(2)}`);

    const buffer = currentATR * 0.3;
    const acceleration = emaSlope - previousSlope;

    // Slope filter: 1.5x stricter in DEFENSE, standard elsewhere
    const slopeMultiplier = (riskState === RISK_STATE.DEFENSE) ? 1.5 : 1.0;
    const strongTrend = Math.abs(emaSlope) > (currentATR * 0.02 * slopeMultiplier);
    const accelerating = Math.abs(acceleration) > (currentATR * 0.01);
    previousSlope = emaSlope;

    // Scaling only allowed in NORMAL
    const scalingAllowed = (riskState === RISK_STATE.NORMAL);

    // Lot size: forced to 1 in DEFENSE and RECOVERY
    const forceSingleLot = (riskState === RISK_STATE.DEFENSE || riskState === RISK_STATE.RECOVERY);
    
    
    const almaBandwidth = almaHigh - almaLow;
    const sidewaysMarket = almaBandwidth < currentATR * 0.8;

    if(sidewaysMarket){
        log("Regime: SIDEWAYS → Skipping entries");
    return;
    }
    if(state === "WAIT"){

        const longBreak  = price > almaHigh + buffer;
        const shortBreak = price < almaLow  - buffer;

        // In DEFENSE: require ATR expansion of at least 10% vs previous candle
        // Guards against sideways revenge trades in choppy conditions
        if(riskState === RISK_STATE.DEFENSE){
            const atrExpanded = previousATR === 0 || currentATR > previousATR * 1.1;
            if(!atrExpanded){
                log("DEFENSE: ATR expansion insufficient — skipping entry");
                return;
            }
        }

        if(longBreak){
            log("Breakout LONG");
            position = "LONG";
            lotSize = forceSingleLot ? 1 : calculateLot();
            if(forceSingleLot) log(`Controlled Entry (${riskState}): 1 Lot`);
            entryPrice = price;
            tradeStartTime = Date.now();
            state = "PROBATION";

            sendTelegram(
                `🚀 ENTER LONG\n` +
                `Lots: ${lotSize}\n` +
                `Price: ${price.toFixed(2)}\n` +
                `State: PROBATION\n` +
                `RiskState: ${riskState}`
            );
        }

        else if(shortBreak){
            log("Breakout SHORT");
            position = "SHORT";
            lotSize = forceSingleLot ? 1 : calculateLot();
            if(forceSingleLot) log(`Controlled Entry (${riskState}): 1 Lot`);
            entryPrice = price;
            tradeStartTime = Date.now();
            state = "PROBATION";

            sendTelegram(
                `🔻 ENTER SHORT\n` +
                `Lots: ${lotSize}\n` +
                `Price: ${price.toFixed(2)}\n` +
                `State: PROBATION\n` +
                `RiskState: ${riskState}`
            );
        }
    }

    else if(state === "PROBATION"){

        if(position === "LONG"){
            if(price > almaHigh && emaSlope > 0){
                log("LONG Confirmed");
                // Confirmation lot bump only in NORMAL — DEFENSE/RECOVERY stay locked at 1
                if(riskState === RISK_STATE.NORMAL){
                    lotSize = Math.min(lotSize + 1, MAX_LOTS);
                }
                state = "CONFIRMED";
            }else{
                log("LONG Probation Failed");
                exitPosition(price);
            }
        }

        if(position === "SHORT"){
            if(price < almaLow && emaSlope < 0){
                log("SHORT Confirmed");
                // Confirmation lot bump only in NORMAL — DEFENSE/RECOVERY stay locked at 1
                if(riskState === RISK_STATE.NORMAL){
                    lotSize = Math.min(lotSize + 1, MAX_LOTS);
                }
                state = "CONFIRMED";
            }else{
                log("SHORT Probation Failed");
                exitPosition(price);
            }
        }
    }

    else if(state === "CONFIRMED"){
    
        const tradeAge = Date.now() - tradeStartTime;

      if(tradeAge > MAX_TRADE_DURATION){
         log("Trade expired → exiting");
         exitPosition(price);
         return;
      }

        if(position === "LONG" && price < almaHigh){
            pullbackCount++;
            if(pullbackCount >= 2) exitPosition(price);
        }

        if(position === "SHORT" && price > almaLow){
            pullbackCount++;
            if(pullbackCount >= 2) exitPosition(price);
        }
        
        const breakoutDistance = Math.abs(price - entryPrice);

         if(breakoutDistance < currentATR * 0.4){
             scalingAllowed = false;
          }       

        // Scaling: NORMAL only
        if(scalingAllowed && strongTrend && accelerating){
            lotSize = Math.min(lotSize + 1, MAX_LOTS);
            log(`Scaling to ${lotSize}`);
        }
    }
}

// ================= 15m ENGINE =================

async function strategyLoop(){

    const now = new Date();

    if(now.getHours() < 9 || now.getHours() >= 23) return;

    const minute = now.getMinutes();
    if(minute % 15 !== 0) return;

    const key = `${now.getHours()}-${minute}`;
    if(lastCandleExecuted === key) return;
    lastCandleExecuted = key;

    log(`🕯 15m Candle @ ${now.toLocaleTimeString()}`);

    const from = new Date(now.getTime() - (1000 * 60 * 60 * 24 * 7));

    const candles = await kc.getHistoricalData(
        SYMBOL.instrument_token,
        INTERVAL,
        from,
        now
    );

    // Always compute indicators (even in COOL_DOWN, per spec)
    const ha = heikinAshi(candles);
    const emaValues = ema(ha.map(x => x.close), EMA_LENGTH);
    const emaSlope = emaValues.at(-1) - emaValues.at(-2);

    const almaHigh = alma(candles.map(x => x.high)).at(-1);
    const almaLow  = alma(candles.map(x => x.low)).at(-1);

    previousATR = currentATR;           // capture before overwrite
    currentATR = atr(candles);
    const price = candles.at(-1).close;

    // Evaluate and potentially transition risk state (once per candle)
    evaluateRiskState();

    // Run strategy (propGuards inside will block if COOL_DOWN / HARD_HALT)
    decisionEngine(price, almaHigh, almaLow, emaSlope);
}

setInterval(() => {
    strategyLoop().catch(err => log("ERROR: " + err.message));
}, 1000);

// ================= LIFECYCLE ENGINE =================

setInterval(() => {

    const now = new Date();

    // 23:00 Force Close
    if(now.getHours() === 23 && !lifecycleClosed){
        lifecycleClosed = true;
        if(position){
            log("🔔 23:00 Force Closing Position");
            exitPosition(livePrice || entryPrice);
        }
    }

    // 23:15 Shutdown
    if(now.getHours() === 23 && now.getMinutes() === 15 && !lifecycleShutdown){
        lifecycleShutdown = true;
        log("📴 23:15 Clean Shutdown");
        sendTelegram(
            `📊 Session Closed\n` +
            `Final PnL: ${sessionPnL.toFixed(0)}\n` +
            `Final Risk State: ${riskState}\n` +
            `Bot Shutting Down`
        );
        setTimeout(() => process.exit(0), 2000);
    }

}, 30000);
