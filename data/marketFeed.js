"use strict";
const { KiteTicker } = require("kiteconnect");
const { SYMBOL, PRESSURE_THRESHOLD, RISK_STATE, S } = require("../core/state");
const { log, sendTelegram, startupHealthCheck, tokenDate } = require("../core/logger");
const { exitPosition, kc } = require("../core/execution");

const API_KEY     = process.env.API_KEY;
const ACCESS_TOKEN = require("../core/logger").ACCESS_TOKEN;

const ticker = new KiteTicker({ api_key: API_KEY, access_token: ACCESS_TOKEN });

function startMarketFeed(){
    ticker.connect();

    ticker.on("connect", () => {
        ticker.subscribe([SYMBOL.instrument_token]);
        ticker.setMode(ticker.modeFull, [SYMBOL.instrument_token]);
        log("WS Connected");
        sendTelegram(`🟢 Started\n📅${tokenDate}\n💰${S.sessionPnL}\n⚙${S.riskState}\n\n${startupHealthCheck()}`);
    });

    ticker.on("ticks", ticks => {
        if(S.riskState === RISK_STATE.HARD_HALT || !ticks.length) return;
        S.livePrice = ticks[0].last_price;
        if(S.lastTickPrice > 0){
            if(S.livePrice > S.lastTickPrice){ S.buyPressure++;  S.sellPressure = 0; }
            else if(S.livePrice < S.lastTickPrice){ S.sellPressure++; S.buyPressure  = 0; }
            S.aggressiveBuy  = S.buyPressure  >= PRESSURE_THRESHOLD;
            S.aggressiveSell = S.sellPressure >= PRESSURE_THRESHOLD;
        }
        S.lastTickPrice = S.livePrice;
        // Trap exit — fires in tick handler for fast response
        if(S.position && S.state === "PROBATION" && S.currentATR && !S.isExiting
            && Math.abs(S.livePrice - S.entryPrice) > S.currentATR * 1.1){
            log(`⚠ Trap@${S.livePrice}`);
            sendTelegram(`⚠ TRAP@${S.livePrice}`);
            exitPosition(S.livePrice);
        }
    });

    ticker.on("error", err => log(`WS error: ${err.message}`));
    ticker.on("close", () => log("WS closed"));
}

module.exports = { startMarketFeed };
