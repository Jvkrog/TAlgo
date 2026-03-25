"use strict";
const { KiteConnect } = require("kiteconnect");
const {
    SYMBOL, CAPITAL, MAX_LOTS, MAX_EXPOSURE, LOT_MULTIPLIER, COOLDOWN_DURATION_MS,
    MAX_ORDERS_PER_TRADE, MAX_TRADE_DURATION, MIN_TRADE_GAP, MAX_TRADES_PER_DAY,
    TRADE_COST_PER_LOT, MIN_REWARD_RATIO, LIMIT_BUFFER_ATR, LIMIT_TIMEOUT_MS,
    RISK_STATE, S
} = require("./state");
const { log, sendTelegram } = require("./logger");
const { propGuards } = require("./riskManager");
const { recordStrategyOutcome, recordPerformance, adaptRouterThreshold, strategyWinRate } = require("../strategy/router");

const API_KEY     = process.env.API_KEY;
const ACCESS_TOKEN = require("./logger").ACCESS_TOKEN;
const kc = new KiteConnect({ api_key: API_KEY });
kc.setAccessToken(ACCESS_TOKEN);

// ─── SMART EXECUTION ──────────────────────────────────────────────────────────

async function placeSmartEntry(dir,lots,price,tag){
    const buf=S.currentATR*LIMIT_BUFFER_ATR;
    const limitPrice=dir===1?+(price-buf).toFixed(2):+(price+buf).toFixed(2);
    const txType=dir===1?kc.TRANSACTION_TYPE_BUY:kc.TRANSACTION_TYPE_SELL;
    try{
        const resp=await kc.placeOrder("regular",{exchange:SYMBOL.exchange,tradingsymbol:SYMBOL.tradingsymbol,transaction_type:txType,quantity:lots,product:"NRML",order_type:"LIMIT",price:limitPrice});
        S.pendingOrder={orderId:resp.order_id,dir,lots,limitPrice,placedAt:Date.now(),tag};
        log(`📤 LIMIT ${dir===1?"BUY":"SELL"} ${lots}L@${limitPrice} [${tag}] id:${resp.order_id}`);
        sendTelegram(`📤 LIMIT ${dir===1?"BUY":"SELL"} [${tag}]\n${lots}L @ ₹${limitPrice} | ${S.riskState}`);
    }catch(err){ log(`❌ Limit failed: ${err.message} — trying market`); await placeMarketEntry(dir,lots,price,tag); }
}

async function placeMarketEntry(dir,lots,price,tag){
    const txType=dir===1?kc.TRANSACTION_TYPE_BUY:kc.TRANSACTION_TYPE_SELL;
    try{
        const resp=await kc.placeOrder("regular",{exchange:SYMBOL.exchange,tradingsymbol:SYMBOL.tradingsymbol,transaction_type:txType,quantity:lots,product:"NRML",order_type:"MARKET"});
        log(`📤 MARKET ${dir===1?"BUY":"SELL"} ${lots}L [${tag}] id:${resp.order_id}`);
        activatePosition(dir,lots,price,tag);
    }catch(err){ log(`❌ Market order failed: ${err.message}`); sendTelegram(`❌ ORDER FAILED [${tag}]: ${err.message}`); }
}

async function cancelPendingOrder(){
    if(!S.pendingOrder) return;
    try{ await kc.cancelOrder("regular",S.pendingOrder.orderId); log(`🚫 Limit cancelled: ${S.pendingOrder.orderId}`); }
    catch(err){ log(`⚠ Cancel failed: ${err.message}`); }
    S.pendingOrder=null;
}

async function checkPendingOrder(){
    if(!S.pendingOrder) return;
    try{
        const history=await kc.getOrderHistory(S.pendingOrder.orderId);
        const latest=history.at(-1);
        if(latest?.status==="COMPLETE"){
            const fillPrice=latest.average_price||S.pendingOrder.limitPrice;
            log(`✅ Limit filled@${fillPrice} [${S.pendingOrder.tag}]`);
            const{dir,lots,tag}=S.pendingOrder; S.pendingOrder=null;
            activatePosition(dir,lots,fillPrice,tag); return;
        }
        if(latest?.status==="REJECTED"||latest?.status==="CANCELLED"){
            log(`⚠ Order ${latest.status} — retrying market`);
            const{dir,lots,limitPrice,tag}=S.pendingOrder; S.pendingOrder=null;
            await placeMarketEntry(dir,lots,S.livePrice||limitPrice,tag); return;
        }
    }catch(err){ log(`⚠ Order status check failed: ${err.message}`); }
    const elapsed=Date.now()-S.pendingOrder.placedAt;
    if(elapsed<LIMIT_TIMEOUT_MS) return;
    log(`⏱ Limit timeout ${(elapsed/1000).toFixed(0)}s — cancelling→market`);
    sendTelegram(`⏱ Limit timeout → market [${S.pendingOrder.tag}]`);
    const{dir,lots,limitPrice,tag}=S.pendingOrder;
    await cancelPendingOrder();
    await placeMarketEntry(dir,lots,S.livePrice||limitPrice,tag);
}

async function placeExitOrder(lots){
    const txType=S.position==="LONG"?kc.TRANSACTION_TYPE_SELL:kc.TRANSACTION_TYPE_BUY;
    try{
        const resp=await kc.placeOrder("regular",{exchange:SYMBOL.exchange,tradingsymbol:SYMBOL.tradingsymbol,transaction_type:txType,quantity:lots,product:"NRML",order_type:"MARKET"});
        log(`📤 EXIT MARKET ${txType} ${lots}L id:${resp.order_id}`);
    }catch(err){ log(`❌ Exit failed: ${err.message}`); sendTelegram(`❌ EXIT FAILED: ${err.message}`); }
}

function activatePosition(dir,lots,price,tag){
    S.position=dir===1?"LONG":"SHORT"; S.lotSize=lots; S.entryPrice=price; S.tradeStartTime=Date.now();
    S.state="PROBATION"; S.totalExposure+=lots; S.ordersInTrade++;
    log(`✅ ${S.position} ${lots}L@${price.toFixed(2)} [${tag}]`);
    sendTelegram(`✅ FILLED ${S.position} [${tag}]\n${lots}L @ ₹${price.toFixed(2)} | ${S.riskState} | Exp:${S.totalExposure}/${MAX_EXPOSURE}`);
}

function enterTrade(dir,requestedLots,price,tag){
    const lots=S.volatilityRegime==="HIGH_VOL"?1:requestedLots;
    placeSmartEntry(dir,lots,price,tag).catch(err=>log(`enterTrade err:${err.message}`));
}

function exitPosition(price){
    if(S.isExiting) return; S.isExiting=true;
    if(S.pendingOrder) cancelPendingOrder().catch(()=>{});
    placeExitOrder(S.lotSize).catch(err=>log(`exitOrder err:${err.message}`));
    const pnl=(S.position==="LONG"?price-S.entryPrice:S.entryPrice-price)*S.lotSize*LOT_MULTIPLIER;
    S.sessionPnL+=pnl;
    log(`EXIT ${S.position} ${S.lotSize}L PnL:${pnl.toFixed(0)} Sess:${S.sessionPnL.toFixed(0)}`);
    sendTelegram(`❌EXIT ${S.position}\n${S.lotSize}L|${price.toFixed(2)}\nPnL:${pnl.toFixed(0)}|Sess:${S.sessionPnL.toFixed(0)}\n${S.riskState}|${S.volatilityRegime}`);
    if(pnl<0){
        if(S.riskState===RISK_STATE.DEFENSE){
            if(++S.defenseLossCount>=2){ S.cooldownStartTime=Date.now(); S.riskState=RISK_STATE.COOL_DOWN;
                log("🟠→COOL_DOWN"); sendTelegram(`🟠 COOL_DOWN\nResume:${new Date(S.cooldownStartTime+COOLDOWN_DURATION_MS).toLocaleTimeString()}`);
            } else log(`DEFENSE loss#${S.defenseLossCount}`); }
        if(S.riskState===RISK_STATE.RECOVERY){ S.recoveryWinCount=0; log("RECOVERY reset"); }
    } else {
        if(S.riskState===RISK_STATE.RECOVERY&&++S.recoveryWinCount>=1){ S.riskState=RISK_STATE.NORMAL; S.recoveryWinCount=S.defenseLossCount=0; log("🟢→NORMAL"); sendTelegram("🟢 NORMAL restored"); }
        if(S.riskState===RISK_STATE.DEFENSE) S.defenseLossCount=0; }
    if(S.selectedStrategy!=="NONE"){
        recordStrategyOutcome(S.selectedStrategy,pnl>0);
        log(`📈[${S.selectedStrategy}] ${(strategyWinRate(S.selectedStrategy)*100).toFixed(0)}%/${S.strategyMemory[S.selectedStrategy].length}t`); }
    recordPerformance(pnl); adaptRouterThreshold();
    S.totalExposure=Math.max(0,S.totalExposure-S.lotSize);
    S.position=null; S.lotSize=0; S.state="WAIT"; S.pullbackCount=0; S.tradeStartTime=null;
    S.selectedStrategy="NONE"; S.routerScore=0; S.breakoutPending=false;
    S.isExiting=false; S.isProbe=false; S.ordersInTrade=0;
    S.lastTradeTime=Date.now(); S.tradesToday++;
}

// ─── DECISION ENGINE ──────────────────────────────────────────────────────────

function decisionEngine(price,almaHigh,almaLow,emaSlope){
    if(!propGuards()) return;
    const buf=S.currentATR*0.3,acc=emaSlope-S.previousSlope,sm=S.riskState===RISK_STATE.DEFENSE?1.5:1.0;
    const strongTrend=Math.abs(emaSlope)>S.currentATR*0.02*sm, accelerating=Math.abs(acc)>S.currentATR*0.01;
    const fsl=S.riskState===RISK_STATE.DEFENSE||S.riskState===RISK_STATE.RECOVERY||S.riskState===RISK_STATE.HARD_HALT||S.isProbe;
    let scaleOk=S.riskState===RISK_STATE.NORMAL&&!S.isProbe;
    const entryLots=fsl?1:Math.max(1,Math.min(Math.floor(S.routerScore),MAX_LOTS));
    const maxScale=Math.max(0,S.routerScore-2);
    S.previousSlope=emaSlope;

    if(S.state==="WAIT"){
        if(S.selectedStrategy==="NO_TRADE"){ log("🚫 NO_TRADE"); return; }
        if(S.totalExposure+entryLots>MAX_EXPOSURE){ log(`🚧 Exp:${S.totalExposure}+${entryLots}`); return; }
        if(S.tradesToday>=MAX_TRADES_PER_DAY){ log(`🛑 Cap:${S.tradesToday}/${MAX_TRADES_PER_DAY}`); return; }
        if(Date.now()-S.lastTradeTime<MIN_TRADE_GAP){ log(`⏳ CD:${Math.ceil((MIN_TRADE_GAP-(Date.now()-S.lastTradeTime))/60000)}m`); return; }
        if(S.currentATR*LOT_MULTIPLIER<TRADE_COST_PER_LOT*2){ log(`📏 ATR₹${(S.currentATR*LOT_MULTIPLIER).toFixed(0)}<cost`); return; }
        const ep=S.currentATR*0.5*entryLots*LOT_MULTIPLIER, tc=TRADE_COST_PER_LOT*entryLots*MIN_REWARD_RATIO;
        if(ep<tc){ log(`💸 Edge:₹${ep.toFixed(0)}<₹${tc.toFixed(0)}`); return; }
        if(S.riskState===RISK_STATE.DEFENSE&&!(S.previousATR===0||S.currentATR>S.previousATR*1.1||S.trendRegime!=="SIDEWAYS")){ log("DEFENSE:skip"); return; }

        if(S.selectedStrategy==="TREND_LONG"||S.selectedStrategy==="TREND_SHORT"){
            if(S.falseBreak){ log(`⚠ FB skip`); return; }
            const dir=S.selectedStrategy==="TREND_LONG"?1:-1, level=dir===1?almaHigh:almaLow;
            const broke=dir===1?price>level+buf:price<level-buf, holds=dir===1?price>level:price<level;
            if(broke&&!S.breakoutPending){ S.breakoutPending=true; log(`⏳${S.selectedStrategy} ${level.toFixed(2)}`); }
            else if(S.breakoutPending&&holds){ S.breakoutPending=false; enterTrade(dir,entryLots,price,S.selectedStrategy); }
            else if(S.breakoutPending&&(dir===1?price<=level:price>=level)){ S.breakoutPending=false; log(`⚠ ${S.selectedStrategy} cancelled`); }
        }
        else if(S.selectedStrategy==="MEAN_REVERSION"){
            const mid=(almaHigh+almaLow)/2;
            if(Math.abs(price-mid)>S.currentATR*0.6){
                if(price>almaHigh) enterTrade(-1,1,price,"MR"); else if(price<almaLow) enterTrade(1,1,price,"MR"); } }
        else if(S.selectedStrategy==="MOMENTUM_SHORT") enterTrade(-1,1,price,"MOM_SHORT");
    }
    else if(S.state==="PROBATION"){
        const dir=S.position==="LONG"?1:-1, level=S.position==="LONG"?almaHigh:almaLow;
        const holds=dir===1?price>level&&emaSlope>0:price<level&&emaSlope<0;
        if(holds){ log(`${S.position} Confirmed`);
            if(S.riskState===RISK_STATE.NORMAL&&S.totalExposure+1<=MAX_EXPOSURE){ S.lotSize=Math.min(S.lotSize+1,MAX_LOTS); S.totalExposure++; }
            S.state="CONFIRMED"; }
        else{ log(`${S.position} Failed`); exitPosition(price); }
    }
    else if(S.state==="CONFIRMED"){
        if(Date.now()-S.tradeStartTime>MAX_TRADE_DURATION){ log("Expired"); exitPosition(price); return; }
        if(S.selectedStrategy==="MEAN_REVERSION"){
            const mid=(almaHigh+almaLow)/2;
            if((S.position==="LONG"&&price>=mid)||(S.position==="SHORT"&&price<=mid)){ log(`MR@${mid.toFixed(2)}`); exitPosition(price); }
        } else {
            const dir=S.position==="LONG"?1:-1, level=S.position==="LONG"?almaHigh:almaLow;
            if((dir===1&&price<level)||(dir===-1&&price>level)) if(++S.pullbackCount>=2) exitPosition(price); }
        if(Math.abs(price-S.entryPrice)<S.currentATR*0.4) scaleOk=false;
        if(S.ordersInTrade>=MAX_ORDERS_PER_TRADE) scaleOk=false;
        const inProfit=(S.position==="LONG"&&price>S.entryPrice)||(S.position==="SHORT"&&price<S.entryPrice);
        if(scaleOk&&inProfit&&S.volatilityRegime==="NORMAL_VOL"&&strongTrend&&accelerating&&S.totalExposure+1<=MAX_EXPOSURE&&(S.lotSize-entryLots)<maxScale){
            S.lotSize=Math.min(S.lotSize+1,MAX_LOTS); S.totalExposure++; S.ordersInTrade++;
            log(`Scale→${S.lotSize}L ${S.lotSize-entryLots}/${maxScale} Exp:${S.totalExposure}/${MAX_EXPOSURE}`); }
    }
}

module.exports = { decisionEngine, exitPosition, enterTrade, checkPendingOrder, kc };
