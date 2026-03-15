"use strict";
const { SYMBOL, INTERVAL, EMA_LENGTH, MPI_THRESHOLD, VOL_SPIKE_MULT, STAGNATION_LIMIT, MAX_TRADES_PER_DAY, RISK_STATE, S, resetDaily } = require("./state");
const { log, sendTelegram, decisionSnapshot, logStrategyStats } = require("./logger");
const { heikinAshi, ema, alma, atr } = require("../market/indicators");
const { updateAtrHistory, smoothATR, detectVolatilityRegime, applyVolatilityRegime, detectTrendRegime, getMarketSession, classifyMarket } = require("../market/classifier");
const { updateLiquidityZones, analyzeLiquidity } = require("../market/liquidity");
const { strategyRouter } = require("../strategy/router");
const { decisionEngine, exitPosition, checkPendingOrder } = require("./execution");
const { fetchCandles, fetchHtfTrend } = require("../data/candles");
const { kc } = require("./execution");

async function strategyLoop(){
    if(S.loopRunning) return; S.loopRunning = true;
    try{
        const now = new Date(), hour = now.getHours(), minute = now.getMinutes();
        if(hour < 9 || hour >= 23) return;
        if((minute - 1) % 15 !== 0) return;
        const slot = Math.floor(Date.now() / 900000);
        if(slot === S.lastCandleExecuted) return;
        S.lastCandleExecuted = slot;
        log(`🕯 15m@${now.toLocaleTimeString()}`);

        // Snapshot orderflow + compute MPI, then reset for next candle
        const aBuy = S.aggressiveBuy, aSell = S.aggressiveSell;
        S.marketPressure = S.buyPressure - S.sellPressure;
        log(`🔬 buy=${aBuy} sell=${aSell} str:${S.buyPressure}/${S.sellPressure} MPI:${S.marketPressure}`);
        S.buyPressure = S.sellPressure = 0; S.aggressiveBuy = S.aggressiveSell = false;

        // Candles (cache-first)
        const candles = await fetchCandles(kc, now);
        if(candles.length < 40){ log(`⚠ History:${candles.length}`); return; }

        // Indicators
        const ha = heikinAshi(candles), emaValues = ema(ha.map(x => x.close), EMA_LENGTH);
        const emaSlope = emaValues.at(-1) - emaValues.at(-2);
        const almaHigh = alma(candles.map(c => c.high)).at(-1);
        const almaLow  = alma(candles.map(c => c.low)).at(-1);
        const price = candles.at(-1).close, lc = candles.at(-1);

        // ATR + volatility regime
        S.previousATR = S.currentATR; S.currentATR = atr(candles);
        updateAtrHistory(S.currentATR); S.smoothedATR = smoothATR(S.currentATR);
        S.volatilityRegime = detectVolatilityRegime(S.smoothedATR, S.atrHistory);

        // Candle flags
        const lcRange = lc.high - lc.low;
        S.volatilityExpansion = Math.abs(lc.close - lc.open) > S.currentATR * 1.8;
        S.momentumExhausted   = lcRange > 0 && (Math.abs(lc.high - lc.close) / lcRange) > 0.5;
        S.falseBreak          = lcRange > 0 && Math.abs(lc.close - lc.open) / lcRange < 0.3;
        if(S.falseBreak) log("⚠ WeakBody");

        // Regimes + classifier
        S.trendRegime   = detectTrendRegime(price, almaHigh, almaLow, emaSlope);
        S.marketSession = getMarketSession();
        S.mkt           = classifyMarket(candles, S.currentATR);
        S.compression   = candles.slice(-5).reduce((s,c) => s + (c.high - c.low), 0) / 5 < S.currentATR * 0.5;
        S.htfAligned    = S.htfTrend === S.trendRegime && S.trendRegime !== "SIDEWAYS";
        const avgVol = candles.slice(-10).reduce((s,c) => s + c.volume, 0) / 10;
        S.volumeSpike   = lc.volume > avgVol * 1.5;
        S.marketEnergy  = (S.compression?1:0) + (S.volumeSpike?1:0) + (Math.abs(S.marketPressure)>MPI_THRESHOLD?1:0);
        log(`⚡ E:${S.marketEnergy}/3${S.marketEnergy >= 2 ? " 🔥" : ""}`);

        // Liquidity
        updateLiquidityZones(candles, S.currentATR);
        S.liq = analyzeLiquidity(lc, candles.at(-2), price);
        log(`📊 ${S.volatilityRegime}(${S.currentATR.toFixed(2)}) ${S.trendRegime} ${S.marketSession} HTF:${S.htfTrend}(${S.htfAligned}) mkt:${JSON.stringify(S.mkt)} liq:${JSON.stringify(S.liq)}`);
        if(S.volatilityExpansion) log(`⚡ Exp:${Math.abs(lc.close-lc.open).toFixed(2)}`);
        if(S.momentumExhausted) log("⚠ Exhaustion"); if(S.compression) log("🗜 Comp");

        // Volatility spike → COOL_DOWN
        if(S.previousATR > 0 && S.riskState !== RISK_STATE.COOL_DOWN
            && S.volatilityRegime !== "EXTREME_VOL" && S.currentATR > S.previousATR * VOL_SPIKE_MULT){
            S.cooldownCandles = 1; S.riskState = RISK_STATE.COOL_DOWN;
            log(`⚡ VolSpike→CD|${S.currentATR.toFixed(2)} vs ${S.previousATR.toFixed(2)}`);
            sendTelegram(`⚡ Spike→CD\nATR ${S.currentATR.toFixed(2)}`); }

        // Router (only while WAIT)
        if(S.state === "WAIT"){
            const routed = strategyRouter(emaSlope, aBuy, aSell);
            S.selectedStrategy = routed.strategy; S.routerScore = routed.score ?? 0;
            log(`🔀 ${S.selectedStrategy} score=${S.routerScore}|${routed.reason}`);
            if(S.selectedStrategy === "NO_TRADE") S.candlesWithoutTrade++; else S.candlesWithoutTrade = 0;
            const hb = S.riskState === RISK_STATE.HARD_HALT || S.riskState === RISK_STATE.COOL_DOWN
                || S.mkt.isDead || S.volatilityRegime === "EXTREME_VOL" || S.marketSession === "OFF";
            if(S.riskState === RISK_STATE.NORMAL && S.selectedStrategy === "NO_TRADE"
                && S.candlesWithoutTrade >= STAGNATION_LIMIT && !hb){
                const probe = S.trendRegime === "UPTREND" ? "TREND_LONG" : S.trendRegime === "DOWNTREND" ? "TREND_SHORT" : "MEAN_REVERSION";
                S.selectedStrategy = probe; S.candlesWithoutTrade = 0; S.isProbe = true;
                log(`🔍 Probe:${probe}`); sendTelegram(`🔍 Probe:${probe} 1L`); }
        } else { S.candlesWithoutTrade = 0; log(`🔀 ${S.selectedStrategy}(locked)`); }

        // Risk + vol gate
        const { evaluateRiskState } = require("./riskManager");
        evaluateRiskState();
        if(!applyVolatilityRegime(sendTelegram)) return;
        if(slot % 20 === 0) logStrategyStats();

        // Setup confirmation candle (prop-desk trick)
        if(S.state === "WAIT" && S.selectedStrategy !== "NO_TRADE"){
            if(!S.setupCandle){ S.setupCandle = slot; log(`🔍 Setup parked score:${S.routerScore}`); return; }
            if(S.setupCandle !== slot - 1 || S.routerScore < S.ROUTER_THRESHOLD){ S.setupCandle = null; log("🔍 Setup expired"); return; }
            log(`✅ Setup confirmed`); S.setupCandle = null;
        } else { S.setupCandle = null; }

        await checkPendingOrder();
        decisionSnapshot(price);
        decisionEngine(price, almaHigh, almaLow, emaSlope);

    } finally { S.loopRunning = false; }
}

function startLifecycle(){
    // HTF updater — independent hourly interval
    const { fetchHtfTrend } = require("../data/candles");
    fetchHtfTrend(kc);
    setInterval(() => fetchHtfTrend(kc).catch(err => log(`HTF:${err.message}`)), 3600000);

    // Lifecycle — force close at 23:00, shutdown at 23:15
    setInterval(() => {
        const now = new Date();
        if(now.getHours() === 23 && !S.lifecycleClosed){
            S.lifecycleClosed = true;
            if(S.position){ log("🔔 ForceClose"); exitPosition(S.livePrice || S.entryPrice); }
        }
        if(now.getHours() === 23 && now.getMinutes() === 15 && !S.lifecycleShutdown){
            S.lifecycleShutdown = true;
            log("📴 Shutdown");
            sendTelegram(`📊 Closed\nPnL:${S.sessionPnL.toFixed(0)}\n${S.riskState}\nTrades:${S.tradesToday}/${MAX_TRADES_PER_DAY}`);
            resetDaily();
            setTimeout(() => process.exit(0), 2000);
        }
    }, 30000);
}

module.exports = { strategyLoop, startLifecycle };
