// ELITE HYBRID ENGINE — NatGas Mini (MCX) | NORMAL→DEFENSE→COOL_DOWN→RECOVERY→HARD_HALT
"use strict";
require("dotenv").config();
const { KiteConnect, KiteTicker } = require("kiteconnect");
const axios = require("axios");
const fs    = require("fs");
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
async function sendTelegram(msg){
    if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    try { await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        { chat_id: TELEGRAM_CHAT_ID, text: `[${SYMBOL.tradingsymbol}|${SYMBOL.instrument_token}]\n`+msg });
    } catch { console.log("Telegram Error"); }
}
const ACCESS_FILE_PATH = "access_code.txt";
const ACCESS_TOKEN = fs.readFileSync(ACCESS_FILE_PATH,"utf8").trim();
const tokenDate    = new Date(fs.statSync(ACCESS_FILE_PATH).mtime).toLocaleString();
function startupHealthCheck(){
    return ["🩺 Startup Health Check",
        process.env.API_KEY?"✅ API Key":"❌ API Key Missing",
        ACCESS_TOKEN?"✅ Token":"❌ Token Missing",
        (TELEGRAM_TOKEN&&TELEGRAM_CHAT_ID)?"✅ Telegram":"⚠ Telegram Off",
        `🕒 ${tokenDate}`].join("\n");
}
const API_KEY = process.env.API_KEY;
const SYMBOL  = { tradingsymbol:"NATGASMINI26MARFUT", exchange:"MCX", instrument_token:121628679 };
const INTERVAL="15minute", ALMA_LENGTH=20, ALMA_OFFSET=0.85, ALMA_SIGMA=6, EMA_LENGTH=20, ATR_LENGTH=14;
const LOT_MULTIPLIER=1250, CAPITAL=100000, MAX_LOTS=4, MAX_EXPOSURE=MAX_LOTS;
const BASE_DAILY_RISK=0.03, TRAIL_DD_PERCENT=0.06, COOLDOWN_DURATION_MS=3600000, VOL_SPIKE_MULT=2.5;
const ATR_REGIME_WINDOW=20, ATR_SMOOTH_LENGTH=10, STRATEGY_MEMORY_SIZE=20, WIN_RATE_THRESHOLD=0.35;
const PERF_WINDOW=20;            // rolling trade window for self-tuning
let ROUTER_THRESHOLD=3;          // dynamic — adjusts between 2.0 and 4.0 based on win rate
let performanceWindow=[];        // rolling PnL array for adaptRouterThreshold()
const STRATEGY_COOLDOWN_THRESHOLD=0.25; // strategy disabled if win rate drops below this
const PRESSURE_THRESHOLD=6, MPI_THRESHOLD=4, MAX_ZONES=6, LIQUIDITY_ZONE_DISTANCE=0.5;
const STAGNATION_LIMIT=6, MAX_TRADE_DURATION=5400000;
// NORMAL(full) → DEFENSE(1L,no scale) → COOL_DOWN(no entries) → RECOVERY(1L) → HARD_HALT(observe)
// Transitions: NORMAL→DEFENSE PnL≤-1% | DEFENSE→COOL_DOWN 2losses | CD→DEFENSE timer
//              DEFENSE→RECOVERY PnL>-0.25% | RECOVERY→NORMAL 1win | Any→HARD_HALT DD×1.5/trailDD
const RISK_STATE = { NORMAL:"NORMAL", DEFENSE:"DEFENSE", COOL_DOWN:"COOL_DOWN", RECOVERY:"RECOVERY", HARD_HALT:"HARD_HALT" };
let riskState="NORMAL", cooldownStartTime=null, cooldownCandles=0, defenseLossCount=0, recoveryWinCount=0;
const kc = new KiteConnect({ api_key: API_KEY });
kc.setAccessToken(ACCESS_TOKEN);
let equityHigh=CAPITAL, isExiting=false, position=null, lotSize=0, totalExposure=0;
let state="WAIT", entryPrice=0, sessionPnL=0, pullbackCount=0, previousSlope=0, currentATR=0, livePrice=0;
let buyPressure=0, sellPressure=0, lastTickPrice=0, aggressiveBuy=false, aggressiveSell=false;
let marketPressure=0, marketEnergy=0;
let previousATR=0, smoothedATR=0, atrHistory=[];
let volatilityRegime="NORMAL_VOL", trendRegime="SIDEWAYS", marketSession="OPENING";
let htfTrend="SIDEWAYS", htfAligned=false, volumeSpike=false;
let volatilityExpansion=false, momentumExhausted=false, falseBreak=false, compression=false;
let liq={ vacuum:false, sweep:"NONE", wall:false };
let mkt={ isDead:false, isChoppy:false, isTrending:false, isFast:false };
let liquidityZones={ highs:[], lows:[] };
let strategyMemory={ TREND_LONG:[], TREND_SHORT:[], MEAN_REVERSION:[], MOMENTUM_SHORT:[] };
let selectedStrategy="NONE", routerScore=0, breakoutPending=false, lastCandleExecuted=0;
let lifecycleClosed=false, lifecycleShutdown=false, candlesWithoutTrade=0, loopRunning=false;
let isProbe=false, tradeStartTime=null, lastTradeTime=0, setupCandle=null, tradesToday=0, ordersInTrade=0;
let pendingOrder=null; // { orderId, dir, lots, limitPrice, placedAt, tag } — null when no open limit
let candleCache=[]; // rolling 200-candle cache — appended each 15m, avoids full API refetch
const MIN_TRADE_GAP=30*60*1000;
const MAX_TRADES_PER_DAY=6; // 30 min cooldown between trades
const TRADE_COST_PER_LOT=120;   // brokerage + slippage per lot (MCX NatGas Mini estimate)
const MIN_REWARD_RATIO=3;       // expected move must be ≥ 3× trade cost to enter
const MAX_ORDERS_PER_TRADE=3;   // max scaling orders within a single trade (caps brokerage)
const log = msg => console.log(`[${new Date().toLocaleTimeString()}][${riskState}] ${msg}`);
function decisionSnapshot(price){
    log(`📊 SNAP P:${price.toFixed(2)} ${trendRegime} ${volatilityRegime} ${marketSession} strat:${selectedStrategy} score:${routerScore} energy:${marketEnergy} MPI:${marketPressure} HTF:${htfTrend}(${htfAligned}) FB:${falseBreak}`);
}
function logStrategyStats(){
    log("📈 STATS\n" + Object.entries(strategyMemory).map(([s,b]) =>
        !b.length ? `  ${s.padEnd(16)} -` :
        `  ${s.padEnd(16)} ${(b.reduce((a,v)=>a+v,0)/b.length*100).toFixed(0)}% (${b.length}t)`
    ).join("\n"));
}
function heikinAshi(data){
    const ha=[];
    for(let i=0;i<data.length;i++){const c=data[i];
        ha.push(i===0?{open:(c.open+c.close)/2,close:(c.open+c.high+c.low+c.close)/4}
                     :{open:(ha[i-1].open+ha[i-1].close)/2,close:(c.open+c.high+c.low+c.close)/4});}
    return ha;
}
function ema(values,length){
    const k=2/(length+1);let prev=values[0];const r=[prev];
    for(let i=1;i<values.length;i++){prev=values[i]*k+prev*(1-k);r.push(prev);}return r;
}
function alma(values){
    const m=ALMA_OFFSET*(ALMA_LENGTH-1),s=ALMA_LENGTH/ALMA_SIGMA,r=[];
    for(let i=ALMA_LENGTH-1;i<values.length;i++){
        let sum=0,norm=0;
        for(let j=0;j<ALMA_LENGTH;j++){const w=Math.exp(-((j-m)**2)/(2*s*s));sum+=values[i-ALMA_LENGTH+1+j]*w;norm+=w;}
        r.push(sum/norm);}return r;
}
function atr(data){
    const trs=[];
    for(let i=1;i<data.length;i++){const{high,low}=data[i],pc=data[i-1].close;
        trs.push(Math.max(high-low,Math.abs(high-pc),Math.abs(low-pc)));}
    return trs.slice(-ATR_LENGTH).reduce((a,b)=>a+b,0)/ATR_LENGTH;
}
function updateAtrHistory(v){atrHistory.push(v);if(atrHistory.length>ATR_REGIME_WINDOW)atrHistory.shift();}
function smoothATR(raw){
    if(atrHistory.length<ATR_SMOOTH_LENGTH)return raw;
    const a=2/(ATR_SMOOTH_LENGTH+1);let v=atrHistory[0];
    for(let i=1;i<atrHistory.length;i++)v=atrHistory[i]*a+v*(1-a);return v;
}
function detectVolatilityRegime(sATR,hist){
    if(hist.length<5)return"NORMAL_VOL";
    const mean=hist.reduce((a,b)=>a+b,0)/hist.length;
    if(sATR<mean*0.7)return"LOW_VOL";if(sATR<mean*1.3)return"NORMAL_VOL";
    if(sATR<mean*1.8)return"HIGH_VOL";return"EXTREME_VOL";
}
function applyVolatilityRegime(){
    if(volatilityRegime==="EXTREME_VOL"){log("🚨 EXTREME_VOL");sendTelegram("🚨 EXTREME — paused");return false;}
    if(volatilityRegime==="HIGH_VOL")log("⚠ HIGH_VOL→lot=1");return true;
}
function detectTrendRegime(price,almaHigh,almaLow,slope){
    const buf=currentATR*0.2;
    if(price>almaHigh-buf&&slope>0)return"UPTREND";
    if(price<almaLow+buf&&slope<0)return"DOWNTREND";return"SIDEWAYS";
}
function getMarketSession(){
    const t=new Date().getHours()+new Date().getMinutes()/60;
    if(t>=9&&t<11)return"OPENING";if(t>=11&&t<18.5)return"MIDDAY";
    if(t>=18.5&&t<23)return"US_SESSION";return"OFF";
}
function classifyMarket(candles,atrValue){
    const win=candles.slice(-30),last=candles.at(-1);
    const atrAvg=win.slice(-20).reduce((s,c)=>s+Math.max(c.high-c.low,Math.abs(c.high-c.close),Math.abs(c.low-c.close)),0)/Math.min(win.length,20);
    let tc=0,rev=0;
    for(let i=1;i<win.length;i++){const c=win[i],p=win[i-1];
        if(Math.abs(c.close-c.open)>atrValue*0.4)tc++;
        if((c.close-c.open)*(p.close-p.open)<0)rev++;}
    const n=win.length;
    return{isDead:atrValue<atrAvg*0.6,isChoppy:rev/n>0.55,isTrending:tc/n>0.6&&rev/n<0.3,isFast:atrValue>0&&(last.high-last.low)/atrValue>1.5};
}
function updateLiquidityZones(candles,atrVal){
    const lb=3,last=candles.length-2;if(last<lb)return;
    const high=candles[last].high,low=candles[last].low;let swH=true,swL=true;
    for(let i=1;i<=lb;i++){
        if(candles[last-i].high>=high)swH=false;if(candles[last-i].low<=low)swL=false;
        if(candles[last+i]?.high>=high)swH=false;if(candles[last+i]?.low<=low)swL=false;}
    const d=atrVal*0.5;
    if(swH&&!liquidityZones.highs.some(h=>Math.abs(h-high)<d)){liquidityZones.highs.push(high);if(liquidityZones.highs.length>MAX_ZONES)liquidityZones.highs.shift();log(`📌 H@${high.toFixed(2)}`);}
    if(swL&&!liquidityZones.lows.some(l=>Math.abs(l-low)<d)){liquidityZones.lows.push(low);if(liquidityZones.lows.length>MAX_ZONES)liquidityZones.lows.shift();log(`📌 L@${low.toFixed(2)}`);}
}
function analyzeLiquidity(lc,prev,price){
    const body=Math.abs(lc.close-lc.open),range=lc.high-lc.low,d=currentATR*0.1,t=currentATR*LIQUIDITY_ZONE_DISTANCE;
    return{
        vacuum:range>0&&(body/range)>0.8&&range>currentATR*1.5,
        sweep:lc.high>prev.high+d&&lc.close<prev.high?"BEAR_SWEEP":lc.low<prev.low-d&&lc.close>prev.low?"BULL_SWEEP":"NONE",
        wall:liquidityZones.highs.some(h=>h>price&&h-price<t)||liquidityZones.lows.some(l=>l<price&&price-l<t)
    };
}
function recordStrategyOutcome(name,won){
    if(!strategyMemory[name])return;strategyMemory[name].push(won?1:0);
    if(strategyMemory[name].length>STRATEGY_MEMORY_SIZE)strategyMemory[name].shift();
}
function recordPerformance(pnl){
    performanceWindow.push(pnl);
    if(performanceWindow.length>PERF_WINDOW)performanceWindow.shift();
}
function adaptRouterThreshold(){
    if(performanceWindow.length<10)return; // need enough data before adjusting
    const wr=performanceWindow.filter(p=>p>0).length/performanceWindow.length;
    if(wr<0.35&&ROUTER_THRESHOLD<4){ROUTER_THRESHOLD=Math.min(4,+(ROUTER_THRESHOLD+0.5).toFixed(1));log(`⚙ Threshold↑ ${ROUTER_THRESHOLD} (WR:${(wr*100).toFixed(0)}% — tightening)`);}
    else if(wr>0.60&&ROUTER_THRESHOLD>2){ROUTER_THRESHOLD=Math.max(2,+(ROUTER_THRESHOLD-0.5).toFixed(1));log(`⚙ Threshold↓ ${ROUTER_THRESHOLD} (WR:${(wr*100).toFixed(0)}% — loosening)`);}
}
function strategyWinRate(name){const b=strategyMemory[name];if(!b||b.length<5)return 0.5;return b.reduce((s,v)=>s+v,0)/b.length;}
function strategyWeight(name){const wr=strategyWinRate(name);return wr>0.65?1.3:wr>0.55?1.1:wr>0.45?1.0:wr>0.35?0.8:0.6;}
function marketScore(strategy,aBuy,aSell){
    let score=0;const bd=[];
    if(htfAligned){score+=2;bd.push("+2HTF");}
    if(volumeSpike){score+=1;bd.push("+1vol");}
    if(compression){score+=1;bd.push("+1comp");}
    if(mkt.isTrending){score+=1;bd.push("+1trend");}
    if(volatilityRegime==="NORMAL_VOL"){score+=1;bd.push("+1nvol");}
    if(marketEnergy>=2){score+=1;bd.push("+1nrg");}
    if(strategy==="TREND_LONG"||strategy==="TREND_SHORT"){
        const b=strategy==="TREND_LONG";
        if(b&&aBuy){score+=1;bd.push("+1bp");}if(!b&&aSell){score+=1;bd.push("+1sp");}
        if(mkt.isFast){score+=1;bd.push("+1fast");}
        if(b&&marketPressure>MPI_THRESHOLD){score+=1;bd.push("+1MPI↑");}
        if(!b&&marketPressure<-MPI_THRESHOLD){score+=1;bd.push("+1MPI↓");}
    }
    if(strategy==="MEAN_REVERSION"){
        if(volatilityRegime==="LOW_VOL"){score+=1;bd.push("+1lvol");}
        if(!liq.wall){score+=1;bd.push("+1nowall");}
    }
    if(liq.wall){score-=1;bd.push("-1wall");}if(liq.sweep!=="NONE"){score-=1;bd.push("-1sw");}
    if(volatilityRegime==="HIGH_VOL"){score-=1;bd.push("-1hvol");}if(falseBreak){score-=1;bd.push("-1fb");}
    if(strategy==="TREND_LONG"){if(aSell){score-=1;bd.push("-1cs");}if(liq.sweep==="BEAR_SWEEP"){score-=2;bd.push("-2bs");}}
    if(strategy==="TREND_SHORT"){if(aBuy){score-=1;bd.push("-1cb");}if(liq.sweep==="BULL_SWEEP"){score-=2;bd.push("-2bs");}}
    if(strategy==="MEAN_REVERSION"&&mkt.isFast){score-=1;bd.push("-1fast");}
    const wr=strategyWinRate(strategy);if(wr<WIN_RATE_THRESHOLD){score-=1;bd.push(`-1wr${(wr*100).toFixed(0)}`);}
    const wt=strategyWeight(strategy),wScore=+(score*wt).toFixed(2);
    log(`📐[${strategy}] ${score}×${wt}=${wScore} [${bd.join(" ")}]`);return wScore;
}
function strategyRouter(emaSlope,aBuy,aSell){
    const r=(s,reason,score=0)=>({strategy:s,reason,score});
    // Strategy cooldown: temporarily block strategies with win rate below threshold (min 5 trades)
    const mrWR=strategyWinRate("MEAN_REVERSION"),tlWR=strategyWinRate("TREND_LONG"),tsWR=strategyWinRate("TREND_SHORT");
    const gates=[
        [()=>volatilityRegime==="EXTREME_VOL","NO_TRADE","EXTREME_VOL"],
        [()=>liq.vacuum,"NO_TRADE","Vacuum"],
        [()=>mkt.isDead,"NO_TRADE","DEAD"],
        [()=>liq.wall&&trendRegime!=="SIDEWAYS","NO_TRADE","Wall-trend"],
        [()=>mkt.isChoppy&&mrWR>STRATEGY_COOLDOWN_THRESHOLD,"MEAN_REVERSION","CHOPPY"],
        [()=>mkt.isChoppy&&mrWR<=STRATEGY_COOLDOWN_THRESHOLD,"NO_TRADE","CHOPPY+MR-cold"],
        [()=>marketSession==="OPENING"&&volatilityRegime==="HIGH_VOL","MEAN_REVERSION","Open-HVOL"],
        [()=>mkt.isFast&&trendRegime==="SIDEWAYS","NO_TRADE","FAST+SIDE"],
    ];
    for(const[cond,s,reason]of gates)if(cond())return r(s,reason);
    // Per-strategy cooldown checks before scoring
    if(trendRegime==="UPTREND"&&tlWR<=STRATEGY_COOLDOWN_THRESHOLD&&strategyMemory.TREND_LONG.length>=5){log("🧊 TREND_LONG cold — skipping");return r("NO_TRADE","TREND_LONG cold");}
    if(trendRegime==="DOWNTREND"&&tsWR<=STRATEGY_COOLDOWN_THRESHOLD&&strategyMemory.TREND_SHORT.length>=5){log("🧊 TREND_SHORT cold — skipping");return r("NO_TRADE","TREND_SHORT cold");}
    if(trendRegime==="SIDEWAYS"&&mrWR<=STRATEGY_COOLDOWN_THRESHOLD&&strategyMemory.MEAN_REVERSION.length>=5){log("🧊 MR cold — skipping");return r("NO_TRADE","MR cold");}
    if(marketSession==="MIDDAY"&&trendRegime!=="SIDEWAYS"&&Math.abs(emaSlope)<currentATR*0.02)return r("MEAN_REVERSION","Midday-weak");
    if(volatilityExpansion&&trendRegime==="DOWNTREND"&&htfAligned&&marketSession==="US_SESSION"&&volatilityRegime!=="EXTREME_VOL"){
        if(momentumExhausted)return r("NO_TRADE","Exhaustion");return r("MOMENTUM_SHORT","Panic+DOWN");}
    if(trendRegime!=="SIDEWAYS"&&(volatilityRegime==="NORMAL_VOL"||volatilityRegime==="HIGH_VOL")){
        if(trendRegime==="DOWNTREND"&&marketSession!=="US_SESSION")return r("NO_TRADE","SHORT→US only");
        const ts=trendRegime==="UPTREND"?"TREND_LONG":"TREND_SHORT",score=marketScore(ts,aBuy,aSell);
        return score>=ROUTER_THRESHOLD?r(ts,`Score ${score}`,score):r("NO_TRADE",`Score ${score}<${ROUTER_THRESHOLD}`);}
    if(trendRegime==="SIDEWAYS"){
        if(Math.abs(emaSlope)>currentATR*0.03)return r("NO_TRADE","Strong slope");
        const score=marketScore("MEAN_REVERSION",aBuy,aSell);
        return score>=ROUTER_THRESHOLD?r("MEAN_REVERSION",`Score ${score}`,score):r("NO_TRADE",`MR ${score}<${ROUTER_THRESHOLD}`);}
    return r("NO_TRADE",`${trendRegime}+${volatilityRegime}`);
}
async function fetchHtfTrend(){
    try{
        const from=new Date(Date.now()-172800000);
        const c1h=await kc.getHistoricalData(SYMBOL.instrument_token,"60minute",from,new Date());
        if(c1h.length<ALMA_LENGTH+2)return;
        const e1h=ema(heikinAshi(c1h).map(x=>x.close),EMA_LENGTH);
        htfTrend=detectTrendRegime(c1h.at(-1).close,alma(c1h.map(x=>x.high)).at(-1),alma(c1h.map(x=>x.low)).at(-1),e1h.at(-1)-e1h.at(-2));
        log(`🕐 HTF:${htfTrend}`);
    }catch(err){log(`HTF err:${err.message}`);}
}
function propGuards(){
    if(riskState===RISK_STATE.HARD_HALT)log("Guard:HARD_HALT");
    if(riskState===RISK_STATE.COOL_DOWN){
        const msg=cooldownCandles>0?`${cooldownCandles}c left`:`${Math.ceil((COOLDOWN_DURATION_MS-(Date.now()-cooldownStartTime))/60000)}m left`;
        log(`Guard:COOL_DOWN — ${msg}`);return false;}
    return true;
}
function evaluateRiskState(){
    const equity=CAPITAL+sessionPnL;equityHigh=Math.max(equityHigh,equity);
    const base=CAPITAL*BASE_DAILY_RISK,dailyLimit=Math.max(base*0.5,base*(currentATR/10));
    if(sessionPnL<-dailyLimit*1.5||(equityHigh-equity)>=CAPITAL*TRAIL_DD_PERCENT){
        if(riskState!==RISK_STATE.HARD_HALT){riskState=RISK_STATE.HARD_HALT;log("🔴 HARD HALT");
            sendTelegram(`🔴 HARD HALT\nPnL:${sessionPnL.toFixed(0)}\n${sessionPnL<=-dailyLimit*1.5?"DailyLimit×1.5":"TrailDD"}`);}return;}
    if(riskState===RISK_STATE.COOL_DOWN){
        if(cooldownCandles>0){if(--cooldownCandles<=0){riskState=RISK_STATE.DEFENSE;defenseLossCount=0;log("🟡 Spike→DEFENSE");sendTelegram("🟡 Spike CD→DEFENSE");}}
        else if(Date.now()-cooldownStartTime>=COOLDOWN_DURATION_MS){riskState=RISK_STATE.DEFENSE;previousATR=currentATR;defenseLossCount=0;log("🟡 Loss→DEFENSE");sendTelegram("🟡 CD→DEFENSE");}
        return;}
    if(riskState===RISK_STATE.NORMAL&&sessionPnL<=-(CAPITAL*0.01)){riskState=RISK_STATE.DEFENSE;defenseLossCount=0;log("🟡→DEFENSE");sendTelegram(`🟡 DEFENSE\nPnL:${sessionPnL.toFixed(0)}`);return;}
    if(riskState===RISK_STATE.DEFENSE&&sessionPnL>-(CAPITAL*0.0025)){riskState=RISK_STATE.RECOVERY;recoveryWinCount=0;log("🔵→RECOVERY");sendTelegram(`🔵 RECOVERY\nPnL:${sessionPnL.toFixed(0)}`);return;}
    if(riskState===RISK_STATE.RECOVERY&&sessionPnL<=-(CAPITAL*0.0025)){riskState=RISK_STATE.DEFENSE;defenseLossCount=0;log("🟡 RECOVERY stalled");sendTelegram(`🟡 RECOVERY stalled\nPnL:${sessionPnL.toFixed(0)}`);}
}
const ticker=new KiteTicker({api_key:API_KEY,access_token:ACCESS_TOKEN});
ticker.connect();
ticker.on("connect",()=>{
    ticker.subscribe([SYMBOL.instrument_token]);ticker.setMode(ticker.modeFull,[SYMBOL.instrument_token]);
    log("WS Connected");sendTelegram(`🟢 Started\n📅${tokenDate}\n💰${sessionPnL}\n⚙${riskState}\n\n${startupHealthCheck()}`);
});
ticker.on("ticks",ticks=>{
    if(riskState===RISK_STATE.HARD_HALT||!ticks.length)return;
    livePrice=ticks[0].last_price;
    if(lastTickPrice>0){
        if(livePrice>lastTickPrice){buyPressure++;sellPressure=0;}
        else if(livePrice<lastTickPrice){sellPressure++;buyPressure=0;}
        aggressiveBuy=buyPressure>=PRESSURE_THRESHOLD;aggressiveSell=sellPressure>=PRESSURE_THRESHOLD;}
    lastTickPrice=livePrice;
    if(position&&state==="PROBATION"&&currentATR&&!isExiting&&Math.abs(livePrice-entryPrice)>currentATR*1.1){
        log(`⚠ Trap@${livePrice}`);sendTelegram(`⚠ TRAP@${livePrice}`);exitPosition(livePrice);}
});
// ─── EXECUTION LAYER ──────────────────────────────────────────────────────────
// Smart limit entry: places limit order at bid-buffer (LONG) or ask+buffer (SHORT).
// Buffer = ATR × 0.05 — small enough to fill quickly, large enough to save spread cost.
// If unfilled after LIMIT_TIMEOUT_MS, cancels and retries as market order once.
const LIMIT_BUFFER_ATR = 0.05;   // limit offset as fraction of ATR
const LIMIT_TIMEOUT_MS = 30000;  // 30s before fallback to market

async function placeSmartEntry(dir, lots, price, tag){
    const buf   = currentATR * LIMIT_BUFFER_ATR;
    const limitPrice = dir === 1 ? +(price - buf).toFixed(2) : +(price + buf).toFixed(2);
    const txType = dir === 1 ? kc.TRANSACTION_TYPE_BUY : kc.TRANSACTION_TYPE_SELL;
    try {
        const resp = await kc.placeOrder("regular", {
            exchange:         SYMBOL.exchange,
            tradingsymbol:    SYMBOL.tradingsymbol,
            transaction_type: txType,
            quantity:         lots,
            product:          "NRML",
            order_type:       "LIMIT",
            price:            limitPrice
        });
        pendingOrder = { orderId: resp.order_id, dir, lots, limitPrice, placedAt: Date.now(), tag };
        log(`📤 LIMIT ${dir===1?"BUY":"SELL"} ${lots}L@${limitPrice} [${tag}] id:${resp.order_id}`);
        sendTelegram(`📤 LIMIT ${dir===1?"BUY":"SELL"} [${tag}]\n${lots}L @ ₹${limitPrice} | ${riskState}`);
    } catch(err) {
        log(`❌ Limit order failed: ${err.message} — trying market`);
        await placeMarketEntry(dir, lots, price, tag);
    }
}

async function placeMarketEntry(dir, lots, price, tag){
    const txType = dir === 1 ? kc.TRANSACTION_TYPE_BUY : kc.TRANSACTION_TYPE_SELL;
    try {
        const resp = await kc.placeOrder("regular", {
            exchange:         SYMBOL.exchange,
            tradingsymbol:    SYMBOL.tradingsymbol,
            transaction_type: txType,
            quantity:         lots,
            product:          "NRML",
            order_type:       "MARKET"
        });
        log(`📤 MARKET ${dir===1?"BUY":"SELL"} ${lots}L [${tag}] id:${resp.order_id}`);
        // Market order fills immediately — activate position directly
        activatePosition(dir, lots, price, tag);
    } catch(err) {
        log(`❌ Market order failed: ${err.message}`);
        sendTelegram(`❌ ORDER FAILED [${tag}]: ${err.message}`);
    }
}

async function cancelPendingOrder(){
    if(!pendingOrder) return;
    try {
        await kc.cancelOrder("regular", pendingOrder.orderId);
        log(`🚫 Limit cancelled: ${pendingOrder.orderId}`);
    } catch(err) {
        log(`⚠ Cancel failed: ${err.message}`);
    }
    pendingOrder = null;
}

// Called every candle to check if a pending limit order timed out
async function checkPendingOrder(){
    if(!pendingOrder) return;
    // Always check broker status first — limit may have filled silently
    try{
        const history=await kc.getOrderHistory(pendingOrder.orderId);
        const latest=history.at(-1);
        if(latest?.status==="COMPLETE"){
            const fillPrice=latest.average_price||pendingOrder.limitPrice;
            log(`✅ Limit filled@${fillPrice} [${pendingOrder.tag}]`);
            const{dir,lots,tag}=pendingOrder;
            pendingOrder=null;
            activatePosition(dir,lots,fillPrice,tag);
            return;
        }
        if(latest?.status==="REJECTED"||latest?.status==="CANCELLED"){
            log(`⚠ Order ${latest.status} — retrying market [${pendingOrder.tag}]`);
            const{dir,lots,limitPrice,tag}=pendingOrder;
            pendingOrder=null;
            await placeMarketEntry(dir,lots,livePrice||limitPrice,tag);
            return;
        }
    }catch(err){log(`⚠ Order status check failed: ${err.message}`);}
    // Still open — check timeout
    const elapsed=Date.now()-pendingOrder.placedAt;
    if(elapsed<LIMIT_TIMEOUT_MS) return;
    log(`⏱ Limit timeout ${(elapsed/1000).toFixed(0)}s — cancelling→market`);
    sendTelegram(`⏱ Limit timeout → market fallback [${pendingOrder.tag}]`);
    const{dir,lots,limitPrice,tag}=pendingOrder;
    await cancelPendingOrder();
    await placeMarketEntry(dir,lots,livePrice||limitPrice,tag);
}

async function placeExitOrder(lots){
    const txType = position === "LONG" ? kc.TRANSACTION_TYPE_SELL : kc.TRANSACTION_TYPE_BUY;
    try {
        const resp = await kc.placeOrder("regular", {
            exchange:         SYMBOL.exchange,
            tradingsymbol:    SYMBOL.tradingsymbol,
            transaction_type: txType,
            quantity:         lots,
            product:          "NRML",
            order_type:       "MARKET"
        });
        log(`📤 EXIT MARKET ${txType} ${lots}L id:${resp.order_id}`);
    } catch(err) {
        log(`❌ Exit order failed: ${err.message}`);
        sendTelegram(`❌ EXIT FAILED: ${err.message}`);
    }
}

// Activates internal position state after confirmed fill
function activatePosition(dir, lots, price, tag){
    position   = dir === 1 ? "LONG" : "SHORT";
    lotSize    = lots; entryPrice = price; tradeStartTime = Date.now();
    state      = "PROBATION"; totalExposure += lots; ordersInTrade++;
    log(`✅ Position active: ${position} ${lots}L@${price.toFixed(2)} [${tag}]`);
    sendTelegram(`✅ FILLED ${position} [${tag}]\n${lots}L @ ₹${price.toFixed(2)} | ${riskState} | Exp:${totalExposure}/${MAX_EXPOSURE}`);
}

// Entry point called by decisionEngine — caps lots for HIGH_VOL, fires smart execution
function enterTrade(dir, requestedLots, price, tag){
    const lots = volatilityRegime === "HIGH_VOL" ? 1 : requestedLots;
    placeSmartEntry(dir, lots, price, tag).catch(err => log(`enterTrade err:${err.message}`));
}

function exitPosition(price){
    if(isExiting)return;isExiting=true;
    // Cancel any open limit entry order before exiting
    if(pendingOrder) cancelPendingOrder().catch(()=>{});
    // Place market exit order with broker
    placeExitOrder(lotSize).catch(err=>log(`exitOrder err:${err.message}`));
    const pnl=(position==="LONG"?price-entryPrice:entryPrice-price)*lotSize*LOT_MULTIPLIER;
    sessionPnL+=pnl;
    log(`EXIT ${position} ${lotSize}L PnL:${pnl.toFixed(0)} Sess:${sessionPnL.toFixed(0)}`);
    sendTelegram(`❌EXIT ${position}\n${lotSize}L|${price.toFixed(2)}\nPnL:${pnl.toFixed(0)}|Sess:${sessionPnL.toFixed(0)}\n${riskState}|${volatilityRegime}`);
    if(pnl<0){
        if(riskState===RISK_STATE.DEFENSE){
            if(++defenseLossCount>=2){cooldownStartTime=Date.now();riskState=RISK_STATE.COOL_DOWN;
                log("🟠→COOL_DOWN");sendTelegram(`🟠 COOL_DOWN\n2losses|Resume:${new Date(cooldownStartTime+COOLDOWN_DURATION_MS).toLocaleTimeString()}`);}
            else log(`DEFENSE loss#${defenseLossCount}`);}
        if(riskState===RISK_STATE.RECOVERY){recoveryWinCount=0;log("RECOVERY reset");}
    }else{
        if(riskState===RISK_STATE.RECOVERY&&++recoveryWinCount>=1){riskState=RISK_STATE.NORMAL;recoveryWinCount=defenseLossCount=0;log("🟢→NORMAL");sendTelegram("🟢 NORMAL restored");}
        if(riskState===RISK_STATE.DEFENSE)defenseLossCount=0;}
    if(selectedStrategy!=="NONE"){recordStrategyOutcome(selectedStrategy,pnl>0);log(`📈[${selectedStrategy}] ${(strategyWinRate(selectedStrategy)*100).toFixed(0)}%/${strategyMemory[selectedStrategy].length}t`);}
    recordPerformance(pnl);adaptRouterThreshold();
    totalExposure=Math.max(0,totalExposure-lotSize);
    position=null;lotSize=0;state="WAIT";pullbackCount=0;tradeStartTime=null;
    selectedStrategy="NONE";routerScore=0;breakoutPending=false;isExiting=false;isProbe=false;ordersInTrade=0;
    lastTradeTime=Date.now(); tradesToday++;
}
function decisionEngine(price,almaHigh,almaLow,emaSlope){
    if(!propGuards())return;
    const buf=currentATR*0.3,acc=emaSlope-previousSlope,sm=riskState===RISK_STATE.DEFENSE?1.5:1.0;
    const strongTrend=Math.abs(emaSlope)>currentATR*0.02*sm,accelerating=Math.abs(acc)>currentATR*0.01;
    const fsl=riskState===RISK_STATE.DEFENSE||riskState===RISK_STATE.RECOVERY||riskState===RISK_STATE.HARD_HALT||isProbe;
    let scaleOk=riskState===RISK_STATE.NORMAL&&!isProbe;
    const entryLots=fsl?1:Math.max(1,Math.min(Math.floor(routerScore),MAX_LOTS));
    const maxScale=Math.max(0,routerScore-2);
    previousSlope=emaSlope;
    if(state==="WAIT"){
        if(selectedStrategy==="NO_TRADE"){log("🚫 NO_TRADE");return;}
        if(totalExposure+entryLots>MAX_EXPOSURE){log(`🚧 Exp:${totalExposure}+${entryLots}`);return;}
        if(tradesToday>=MAX_TRADES_PER_DAY){log(`🛑 Daily cap: ${tradesToday}/${MAX_TRADES_PER_DAY} trades`);return;}
        if(Date.now()-lastTradeTime<MIN_TRADE_GAP){log(`⏳ Trade cooldown: ${Math.ceil((MIN_TRADE_GAP-(Date.now()-lastTradeTime))/60000)}m left`);return;}
        // ATR move in rupees must be at least 2× brokerage cost — ensures volatility covers cost
        if(currentATR*LOT_MULTIPLIER<TRADE_COST_PER_LOT*2){log(`📏 ATR ₹${(currentATR*LOT_MULTIPLIER).toFixed(0)} < cost×2 ₹${TRADE_COST_PER_LOT*2} — skip`);return;}
        // Expected profit = ATR×0.5 × entryLots × LOT_MULTIPLIER; must exceed cost × MIN_REWARD_RATIO
        const expectedProfit=currentATR*0.5*entryLots*LOT_MULTIPLIER;
        const totalCost=TRADE_COST_PER_LOT*entryLots*MIN_REWARD_RATIO;
        if(expectedProfit<totalCost){log(`💸 Edge too small: exp ₹${expectedProfit.toFixed(0)} < cost×${MIN_REWARD_RATIO} ₹${totalCost.toFixed(0)}`);return;}
        if(riskState===RISK_STATE.DEFENSE){
            const ok=previousATR===0||currentATR>previousATR*1.1||trendRegime!=="SIDEWAYS";
            if(!ok){log("DEFENSE: skip");return;}}
        if(selectedStrategy==="TREND_LONG"||selectedStrategy==="TREND_SHORT"){
            if(falseBreak){log(`⚠ FalseBreak—skip ${selectedStrategy}`);return;}
            const dir=selectedStrategy==="TREND_LONG"?1:-1,level=dir===1?almaHigh:almaLow;
            const broke=dir===1?price>level+buf:price<level-buf,holds=dir===1?price>level:price<level;
            if(broke&&!breakoutPending){breakoutPending=true;log(`⏳${selectedStrategy} retest ${dir===1?"above":"below"} ${level.toFixed(2)}`);}
            else if(breakoutPending&&holds){breakoutPending=false;if(fsl)log(`Controlled:1L`);enterTrade(dir,entryLots,price,selectedStrategy);}
            else if(breakoutPending&&(dir===1?price<=level:price>=level)){breakoutPending=false;log(`⚠ ${selectedStrategy} cancelled`);}
        }
        else if(selectedStrategy==="MEAN_REVERSION"){
            const mid=(almaHigh+almaLow)/2;
            if(Math.abs(price-mid)>currentATR*0.6){
                if(price>almaHigh)enterTrade(-1,1,price,"MR");else if(price<almaLow)enterTrade(1,1,price,"MR");}}
        else if(selectedStrategy==="MOMENTUM_SHORT")enterTrade(-1,1,price,"MOM_SHORT");
    }
    else if(state==="PROBATION"){
        const dir=position==="LONG"?1:-1,level=position==="LONG"?almaHigh:almaLow;
        const holds=dir===1?price>level&&emaSlope>0:price<level&&emaSlope<0;
        if(holds){log(`${position} Confirmed`);
            if(riskState===RISK_STATE.NORMAL&&totalExposure+1<=MAX_EXPOSURE){lotSize=Math.min(lotSize+1,MAX_LOTS);totalExposure++;}
            state="CONFIRMED";}
        else{log(`${position} Failed`);exitPosition(price);}
    }
    else if(state==="CONFIRMED"){
        if(Date.now()-tradeStartTime>MAX_TRADE_DURATION){log("Expired");exitPosition(price);return;}
        if(selectedStrategy==="MEAN_REVERSION"){
            const mid=(almaHigh+almaLow)/2;
            if((position==="LONG"&&price>=mid)||(position==="SHORT"&&price<=mid)){log(`MR@${mid.toFixed(2)}`);exitPosition(price);}
        }else{
            const dir=position==="LONG"?1:-1,level=position==="LONG"?almaHigh:almaLow;
            if((dir===1&&price<level)||(dir===-1&&price>level))if(++pullbackCount>=2)exitPosition(price);}
        if(Math.abs(price-entryPrice)<currentATR*0.4)scaleOk=false;
        if(ordersInTrade>=MAX_ORDERS_PER_TRADE)scaleOk=false;
        const inProfit=(position==="LONG"&&price>entryPrice)||(position==="SHORT"&&price<entryPrice);
        if(scaleOk&&inProfit&&volatilityRegime==="NORMAL_VOL"&&strongTrend&&accelerating&&totalExposure+1<=MAX_EXPOSURE&&(lotSize-entryLots)<maxScale){
            lotSize=Math.min(lotSize+1,MAX_LOTS);totalExposure++;ordersInTrade++;
            log(`Scale→${lotSize}L ${lotSize-entryLots}/${maxScale} orders:${ordersInTrade}/${MAX_ORDERS_PER_TRADE} Exp:${totalExposure}/${MAX_EXPOSURE}`);}
    }
}
async function strategyLoop(){
    if(loopRunning)return;loopRunning=true;
    try{
        const now=new Date(),hour=now.getHours(),minute=now.getMinutes();
        if(hour<9||hour>=23)return;if((minute-1)%15!==0)return;
        const slot=Math.floor(Date.now()/900000);if(slot===lastCandleExecuted)return;
        lastCandleExecuted=slot;log(`🕯 15m@${now.toLocaleTimeString()}`);
        const aBuy=aggressiveBuy,aSell=aggressiveSell;
        marketPressure=buyPressure-sellPressure;
        log(`🔬 buy=${aBuy} sell=${aSell} str:${buyPressure}/${sellPressure} MPI:${marketPressure}`);
        buyPressure=sellPressure=0;aggressiveBuy=aggressiveSell=false;
        const from=new Date(now.getTime()-1000*60*15*200);
        let candles;
        if(candleCache.length>=40){
            // Append mode: fetch only the last 2 candles to get the newly closed one
            try{
                const recent=await kc.getHistoricalData(SYMBOL.instrument_token,INTERVAL,new Date(now.getTime()-1000*60*15*3),now);
                const newCandle=recent.at(-1);
                // Only append if this candle's timestamp is newer than our last cached candle
                if(newCandle&&(!candleCache.at(-1)||newCandle.date!==candleCache.at(-1).date)){
                    candleCache.push(newCandle);
                    if(candleCache.length>200)candleCache.shift();
                }
                candles=candleCache;
            }catch(err){
                log(`⚠ Cache append failed (${err.message}) — falling back to full fetch`);
                candleCache=[];
            }
        }
        if(!candles||candles.length<40){
            // Cold start or cache miss: full fetch
            candles=await kc.getHistoricalData(SYMBOL.instrument_token,INTERVAL,from,now);
            candleCache=[...candles];
            log(`📥 Full fetch: ${candles.length} candles cached`);
        }
        if(candles.length<40){log(`⚠ History:${candles.length}`);return;}
        const ha=heikinAshi(candles),emaValues=ema(ha.map(x=>x.close),EMA_LENGTH);
        const emaSlope=emaValues.at(-1)-emaValues.at(-2);
        const almaHigh=alma(candles.map(c=>c.high)).at(-1),almaLow=alma(candles.map(c=>c.low)).at(-1);
        const price=candles.at(-1).close,lc=candles.at(-1);
        previousATR=currentATR;currentATR=atr(candles);
        updateAtrHistory(currentATR);smoothedATR=smoothATR(currentATR);
        volatilityRegime=detectVolatilityRegime(smoothedATR,atrHistory);
        const lcRange=lc.high-lc.low;
        volatilityExpansion=Math.abs(lc.close-lc.open)>currentATR*1.8;
        momentumExhausted=lcRange>0&&(Math.abs(lc.high-lc.close)/lcRange)>0.5;
        falseBreak=lcRange>0&&Math.abs(lc.close-lc.open)/lcRange<0.3;
        if(falseBreak)log("⚠ WeakBody—possible fake");
        trendRegime=detectTrendRegime(price,almaHigh,almaLow,emaSlope);
        marketSession=getMarketSession();mkt=classifyMarket(candles,currentATR);
        compression=candles.slice(-5).reduce((s,c)=>s+(c.high-c.low),0)/5<currentATR*0.5;
        htfAligned=htfTrend===trendRegime&&trendRegime!=="SIDEWAYS";
        const avgVol=candles.slice(-10).reduce((s,c)=>s+c.volume,0)/10;
        volumeSpike=lc.volume>avgVol*1.5;
        marketEnergy=(compression?1:0)+(volumeSpike?1:0)+(Math.abs(marketPressure)>MPI_THRESHOLD?1:0);
        log(`⚡ Energy:${marketEnergy}/3${marketEnergy>=2?" 🔥":""}`);
        updateLiquidityZones(candles,currentATR);liq=analyzeLiquidity(lc,candles.at(-2),price);
        log(`📊 ${volatilityRegime}(${currentATR.toFixed(2)}) ${trendRegime} ${marketSession} HTF:${htfTrend}(${htfAligned}) mkt:${JSON.stringify(mkt)} liq:${JSON.stringify(liq)} vol⚡:${volumeSpike}`);
        if(volatilityExpansion)log(`⚡ Exp:${Math.abs(lc.close-lc.open).toFixed(2)}`);
        if(momentumExhausted)log("⚠ Exhaustion");if(compression)log("🗜 Comp");
        if(previousATR>0&&riskState!==RISK_STATE.COOL_DOWN&&volatilityRegime!=="EXTREME_VOL"&&currentATR>previousATR*VOL_SPIKE_MULT){
            cooldownCandles=1;riskState=RISK_STATE.COOL_DOWN;
            log(`⚡ VolSpike→CD|${currentATR.toFixed(2)} vs ${previousATR.toFixed(2)}`);
            sendTelegram(`⚡ Spike→CD\nATR ${currentATR.toFixed(2)}(was ${previousATR.toFixed(2)})`);}
        if(state==="WAIT"){
            const routed=strategyRouter(emaSlope,aBuy,aSell);
            selectedStrategy=routed.strategy;routerScore=routed.score??0;
            log(`🔀 ${selectedStrategy} score=${routerScore}|${routed.reason}`);
            if(selectedStrategy==="NO_TRADE")candlesWithoutTrade++;else candlesWithoutTrade=0;
            const hb=riskState===RISK_STATE.HARD_HALT||riskState===RISK_STATE.COOL_DOWN||mkt.isDead||volatilityRegime==="EXTREME_VOL"||marketSession==="OFF";
            if(riskState===RISK_STATE.NORMAL&&selectedStrategy==="NO_TRADE"&&candlesWithoutTrade>=STAGNATION_LIMIT&&!hb){
                const probe=trendRegime==="UPTREND"?"TREND_LONG":trendRegime==="DOWNTREND"?"TREND_SHORT":"MEAN_REVERSION";
                selectedStrategy=probe;candlesWithoutTrade=0;isProbe=true;
                log(`🔍 Probe:${probe}—idle${STAGNATION_LIMIT}`);sendTelegram(`🔍 Probe:${probe} ${STAGNATION_LIMIT}idle 1L`);}
        }else{candlesWithoutTrade=0;log(`🔀 ${selectedStrategy}(locked)`);}
        evaluateRiskState();if(!applyVolatilityRegime())return;
        if(slot%20===0)logStrategyStats();
        // Setup confirmation candle (prop-desk trick):
        // If score qualifies but no setup is pending → park it, wait one candle.
        // If score still qualifies next candle → confirm and trade.
        // Clears on NO_TRADE, trade open, or score drop.
        if(state==="WAIT"&&selectedStrategy!=="NO_TRADE"){
            if(!setupCandle){setupCandle=slot;log(`🔍 Setup parked — waiting confirmation candle (score:${routerScore})`);return;}
            if(setupCandle!==slot-1||routerScore<ROUTER_THRESHOLD){setupCandle=null;log("🔍 Setup expired — score dropped or slot gap");return;}
            log(`✅ Setup confirmed (${slot-setupCandle} candle) — proceeding`);setupCandle=null;
        }else{setupCandle=null;}
        await checkPendingOrder(); // handle limit order timeout/fallback
        decisionSnapshot(price);decisionEngine(price,almaHigh,almaLow,emaSlope);
    }finally{loopRunning=false;}
}
setInterval(()=>strategyLoop().catch(err=>log("ERR:"+err.message)),1000);
fetchHtfTrend();setInterval(()=>fetchHtfTrend().catch(err=>log("HTF:"+err.message)),3600000);
setInterval(()=>{
    const now=new Date();
    if(now.getHours()===23&&!lifecycleClosed){lifecycleClosed=true;if(position){log("🔔 ForceClose");exitPosition(livePrice||entryPrice);}}
    if(now.getHours()===23&&now.getMinutes()===15&&!lifecycleShutdown){lifecycleShutdown=true;log("📴 Shutdown");
        sendTelegram(`📊 Closed\nPnL:${sessionPnL.toFixed(0)}\n${riskState}\nTrades:${tradesToday}/${MAX_TRADES_PER_DAY}`);
        tradesToday=0;ordersInTrade=0;pendingOrder=null;candleCache=[];strategyMemory={TREND_LONG:[],TREND_SHORT:[],MEAN_REVERSION:[],MOMENTUM_SHORT:[]};
        performanceWindow=[];ROUTER_THRESHOLD=3;
        setTimeout(()=>process.exit(0),2000);}
},30000);
