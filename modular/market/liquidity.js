"use strict";
const { MAX_ZONES, LIQUIDITY_ZONE_DISTANCE, S } = require("../core/state");
const { log } = require("../core/logger");

function updateLiquidityZones(candles,atrVal){
    const lb=3,last=candles.length-2; if(last<lb) return;
    const high=candles[last].high,low=candles[last].low; let swH=true,swL=true;
    for(let i=1;i<=lb;i++){
        if(candles[last-i].high>=high) swH=false; if(candles[last-i].low<=low) swL=false;
        if(candles[last+i]?.high>=high) swH=false; if(candles[last+i]?.low<=low) swL=false; }
    const d=atrVal*0.5;
    if(swH&&!S.liquidityZones.highs.some(h=>Math.abs(h-high)<d)){
        S.liquidityZones.highs.push(high); if(S.liquidityZones.highs.length>MAX_ZONES) S.liquidityZones.highs.shift();
        log(`📌 H@${high.toFixed(2)}`); }
    if(swL&&!S.liquidityZones.lows.some(l=>Math.abs(l-low)<d)){
        S.liquidityZones.lows.push(low); if(S.liquidityZones.lows.length>MAX_ZONES) S.liquidityZones.lows.shift();
        log(`📌 L@${low.toFixed(2)}`); }
}

function analyzeLiquidity(lc,prev,price){
    const body=Math.abs(lc.close-lc.open),range=lc.high-lc.low;
    const d=S.currentATR*0.1, t=S.currentATR*LIQUIDITY_ZONE_DISTANCE;
    return{
        vacuum: range>0&&(body/range)>0.8&&range>S.currentATR*1.5,
        sweep:  lc.high>prev.high+d&&lc.close<prev.high?"BEAR_SWEEP":lc.low<prev.low-d&&lc.close>prev.low?"BULL_SWEEP":"NONE",
        wall:   S.liquidityZones.highs.some(h=>h>price&&h-price<t)||S.liquidityZones.lows.some(l=>l<price&&price-l<t)
    };
}

module.exports = { updateLiquidityZones, analyzeLiquidity };
