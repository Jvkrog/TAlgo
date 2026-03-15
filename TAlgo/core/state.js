"use strict";
// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SYMBOL   = { tradingsymbol:"NATGASMINI26MARFUT", exchange:"MCX", instrument_token:121628679 };
const INTERVAL = "15minute";
const ALMA_LENGTH=20, ALMA_OFFSET=0.85, ALMA_SIGMA=6, EMA_LENGTH=20, ATR_LENGTH=14;
const LOT_MULTIPLIER=1250, CAPITAL=100000, MAX_LOTS=4, MAX_EXPOSURE=MAX_LOTS;
const BASE_DAILY_RISK=0.03, TRAIL_DD_PERCENT=0.06, COOLDOWN_DURATION_MS=3600000, VOL_SPIKE_MULT=2.5;
const ATR_REGIME_WINDOW=20, ATR_SMOOTH_LENGTH=10, STRATEGY_MEMORY_SIZE=20, WIN_RATE_THRESHOLD=0.35;
const STRATEGY_COOLDOWN_THRESHOLD=0.25, PERF_WINDOW=20;
const PRESSURE_THRESHOLD=6, MPI_THRESHOLD=4, MAX_ZONES=6, LIQUIDITY_ZONE_DISTANCE=0.5;
const STAGNATION_LIMIT=6, MAX_TRADE_DURATION=5400000;
const MIN_TRADE_GAP=1800000, MAX_TRADES_PER_DAY=6, TRADE_COST_PER_LOT=120, MIN_REWARD_RATIO=3, MAX_ORDERS_PER_TRADE=3;
const LIMIT_BUFFER_ATR=0.05, LIMIT_TIMEOUT_MS=30000;
const RISK_STATE = { NORMAL:"NORMAL", DEFENSE:"DEFENSE", COOL_DOWN:"COOL_DOWN", RECOVERY:"RECOVERY", HARD_HALT:"HARD_HALT" };

// ─── MUTABLE STATE ────────────────────────────────────────────────────────────
const S = {
    // risk
    riskState:"NORMAL", cooldownStartTime:null, cooldownCandles:0, defenseLossCount:0, recoveryWinCount:0,
    // position
    equityHigh:CAPITAL, isExiting:false, position:null, lotSize:0, totalExposure:0,
    state:"WAIT", entryPrice:0, sessionPnL:0, pullbackCount:0, previousSlope:0,
    currentATR:0, livePrice:0,
    // orderflow
    buyPressure:0, sellPressure:0, lastTickPrice:0, aggressiveBuy:false, aggressiveSell:false,
    marketPressure:0, marketEnergy:0,
    // ATR smoothing
    previousATR:0, smoothedATR:0, atrHistory:[],
    // regimes
    volatilityRegime:"NORMAL_VOL", trendRegime:"SIDEWAYS", marketSession:"OPENING",
    // supporting signals
    htfTrend:"SIDEWAYS", htfAligned:false, volumeSpike:false,
    volatilityExpansion:false, momentumExhausted:false, falseBreak:false, compression:false,
    liq:{ vacuum:false, sweep:"NONE", wall:false },
    mkt:{ isDead:false, isChoppy:false, isTrending:false, isFast:false },
    liquidityZones:{ highs:[], lows:[] },
    // strategy memory + adaptive threshold
    strategyMemory:{ TREND_LONG:[], TREND_SHORT:[], MEAN_REVERSION:[], MOMENTUM_SHORT:[] },
    performanceWindow:[], ROUTER_THRESHOLD:3,
    // execution
    selectedStrategy:"NONE", routerScore:0, breakoutPending:false,
    lastCandleExecuted:0, lifecycleClosed:false, lifecycleShutdown:false,
    candlesWithoutTrade:0, loopRunning:false, isProbe:false,
    tradeStartTime:null, lastTradeTime:0, setupCandle:null,
    tradesToday:0, ordersInTrade:0, pendingOrder:null, candleCache:[],
};

function resetDaily(){
    S.tradesToday=0; S.ordersInTrade=0; S.pendingOrder=null; S.candleCache=[];
    S.strategyMemory={ TREND_LONG:[], TREND_SHORT:[], MEAN_REVERSION:[], MOMENTUM_SHORT:[] };
    S.performanceWindow=[]; S.ROUTER_THRESHOLD=3;
}

module.exports = {
    SYMBOL,INTERVAL,ALMA_LENGTH,ALMA_OFFSET,ALMA_SIGMA,EMA_LENGTH,ATR_LENGTH,
    LOT_MULTIPLIER,CAPITAL,MAX_LOTS,MAX_EXPOSURE,BASE_DAILY_RISK,TRAIL_DD_PERCENT,
    COOLDOWN_DURATION_MS,VOL_SPIKE_MULT,ATR_REGIME_WINDOW,ATR_SMOOTH_LENGTH,
    STRATEGY_MEMORY_SIZE,WIN_RATE_THRESHOLD,STRATEGY_COOLDOWN_THRESHOLD,PERF_WINDOW,
    PRESSURE_THRESHOLD,MPI_THRESHOLD,MAX_ZONES,LIQUIDITY_ZONE_DISTANCE,STAGNATION_LIMIT,
    MAX_TRADE_DURATION,MIN_TRADE_GAP,MAX_TRADES_PER_DAY,TRADE_COST_PER_LOT,MIN_REWARD_RATIO,
    MAX_ORDERS_PER_TRADE,LIMIT_BUFFER_ATR,LIMIT_TIMEOUT_MS,RISK_STATE,
    S, resetDaily
};
