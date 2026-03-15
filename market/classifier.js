"use strict";
const { ATR_REGIME_WINDOW, ATR_SMOOTH_LENGTH, MAX_ZONES, LIQUIDITY_ZONE_DISTANCE, S } = require("../core/state");
const { log } = require("../core/logger");

function updateAtrHistory(v){ S.atrHistory.push(v); if(S.atrHistory.length>ATR_REGIME_WINDOW) S.atrHistory.shift(); }

function smoothATR(raw){
    if(S.atrHistory.length<ATR_SMOOTH_LENGTH) return raw;
    const a=2/(ATR_SMOOTH_LENGTH+1); let v=S.atrHistory[0];
    for(let i=1;i<S.atrHistory.length;i++) v=S.atrHistory[i]*a+v*(1-a); return v;
}

function detectVolatilityRegime(sATR,hist){
    if(hist.length<5) return "NORMAL_VOL";
    const mean=hist.reduce((a,b)=>a+b,0)/hist.length;
    return sATR<mean*0.7?"LOW_VOL":sATR<mean*1.3?"NORMAL_VOL":sATR<mean*1.8?"HIGH_VOL":"EXTREME_VOL";
}

function applyVolatilityRegime(sendTelegram){
    if(S.volatilityRegime==="EXTREME_VOL"){ log("🚨 EXTREME_VOL"); sendTelegram("🚨 EXTREME — paused"); return false; }
    if(S.volatilityRegime==="HIGH_VOL") log("⚠ HIGH_VOL→lot=1"); return true;
}

function detectTrendRegime(price,almaHigh,almaLow,slope){
    const buf=S.currentATR*0.2;
    return price>almaHigh-buf&&slope>0?"UPTREND":price<almaLow+buf&&slope<0?"DOWNTREND":"SIDEWAYS";
}

function getMarketSession(){
    const t=new Date().getHours()+new Date().getMinutes()/60;
    return t>=9&&t<11?"OPENING":t>=11&&t<18.5?"MIDDAY":t>=18.5&&t<23?"US_SESSION":"OFF";
}

function classifyMarket(candles,atrValue){
    const win=candles.slice(-30),last=candles.at(-1);
    const atrAvg=win.slice(-20).reduce((s,c)=>s+Math.max(c.high-c.low,Math.abs(c.high-c.close),Math.abs(c.low-c.close)),0)/Math.min(win.length,20);
    let tc=0,rev=0;
    for(let i=1;i<win.length;i++){const c=win[i],p=win[i-1];
        if(Math.abs(c.close-c.open)>atrValue*0.4) tc++;
        if((c.close-c.open)*(p.close-p.open)<0) rev++;}
    const n=win.length;
    return{ isDead:atrValue<atrAvg*0.6, isChoppy:rev/n>0.55, isTrending:tc/n>0.6&&rev/n<0.3, isFast:atrValue>0&&(last.high-last.low)/atrValue>1.5 };
}

module.exports = { updateAtrHistory, smoothATR, detectVolatilityRegime, applyVolatilityRegime, detectTrendRegime, getMarketSession, classifyMarket };
