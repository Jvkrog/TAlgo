"use strict";
const { STRATEGY_MEMORY_SIZE, WIN_RATE_THRESHOLD, STRATEGY_COOLDOWN_THRESHOLD, PERF_WINDOW, MPI_THRESHOLD, S } = require("../core/state");
const { log } = require("../core/logger");

function recordStrategyOutcome(name,won){
    if(!S.strategyMemory[name]) return;
    S.strategyMemory[name].push(won?1:0);
    if(S.strategyMemory[name].length>STRATEGY_MEMORY_SIZE) S.strategyMemory[name].shift();
}

function recordPerformance(pnl){
    S.performanceWindow.push(pnl);
    if(S.performanceWindow.length>PERF_WINDOW) S.performanceWindow.shift();
}

function adaptRouterThreshold(){
    if(S.performanceWindow.length<10) return;
    const wr=S.performanceWindow.filter(p=>p>0).length/S.performanceWindow.length;
    if(wr<0.35&&S.ROUTER_THRESHOLD<4){ S.ROUTER_THRESHOLD=Math.min(4,+(S.ROUTER_THRESHOLD+0.5).toFixed(1)); log(`⚙ Threshold↑${S.ROUTER_THRESHOLD} WR:${(wr*100).toFixed(0)}%`); }
    else if(wr>0.60&&S.ROUTER_THRESHOLD>2){ S.ROUTER_THRESHOLD=Math.max(2,+(S.ROUTER_THRESHOLD-0.5).toFixed(1)); log(`⚙ Threshold↓${S.ROUTER_THRESHOLD} WR:${(wr*100).toFixed(0)}%`); }
}

function strategyWinRate(n){ const b=S.strategyMemory[n]; if(!b||b.length<5) return 0.5; return b.reduce((s,v)=>s+v,0)/b.length; }
function strategyWeight(n){ const w=strategyWinRate(n); return w>0.65?1.3:w>0.55?1.1:w>0.45?1.0:w>0.35?0.8:0.6; }

function marketScore(strategy,aBuy,aSell){
    let score=0; const bd=[];
    const{htfAligned,volumeSpike,compression,volatilityRegime,marketEnergy,marketPressure,liq,mkt,falseBreak}=S;
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
    if(strategy==="MEAN_REVERSION"){ if(volatilityRegime==="LOW_VOL"){score+=1;bd.push("+1lvol");} if(!liq.wall){score+=1;bd.push("+1nowall");} }
    if(liq.wall){score-=1;bd.push("-1wall");}if(liq.sweep!=="NONE"){score-=1;bd.push("-1sw");}
    if(volatilityRegime==="HIGH_VOL"){score-=1;bd.push("-1hvol");}if(falseBreak){score-=1;bd.push("-1fb");}
    if(strategy==="TREND_LONG"){if(aSell){score-=1;bd.push("-1cs");}if(liq.sweep==="BEAR_SWEEP"){score-=2;bd.push("-2bs");}}
    if(strategy==="TREND_SHORT"){if(aBuy){score-=1;bd.push("-1cb");}if(liq.sweep==="BULL_SWEEP"){score-=2;bd.push("-2bs");}}
    if(strategy==="MEAN_REVERSION"&&mkt.isFast){score-=1;bd.push("-1fast");}
    const wr=strategyWinRate(strategy); if(wr<WIN_RATE_THRESHOLD){score-=1;bd.push(`-1wr${(wr*100).toFixed(0)}`);}
    const wt=strategyWeight(strategy),ws=+(score*wt).toFixed(2);
    log(`📐[${strategy}] ${score}×${wt}=${ws} [${bd.join(" ")}]`); return ws;
}

function strategyRouter(emaSlope,aBuy,aSell){
    const{volatilityRegime,trendRegime,marketSession,liq,mkt,volatilityExpansion,momentumExhausted,htfAligned,currentATR,ROUTER_THRESHOLD}=S;
    const r=(s,reason,score=0)=>({strategy:s,reason,score});
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
    for(const[cond,s,reason]of gates) if(cond()) return r(s,reason);
    if(trendRegime==="UPTREND"&&tlWR<=STRATEGY_COOLDOWN_THRESHOLD&&S.strategyMemory.TREND_LONG.length>=5) return r("NO_TRADE","TREND_LONG cold");
    if(trendRegime==="DOWNTREND"&&tsWR<=STRATEGY_COOLDOWN_THRESHOLD&&S.strategyMemory.TREND_SHORT.length>=5) return r("NO_TRADE","TREND_SHORT cold");
    if(trendRegime==="SIDEWAYS"&&mrWR<=STRATEGY_COOLDOWN_THRESHOLD&&S.strategyMemory.MEAN_REVERSION.length>=5) return r("NO_TRADE","MR cold");
    if(marketSession==="MIDDAY"&&trendRegime!=="SIDEWAYS"&&Math.abs(emaSlope)<currentATR*0.02) return r("MEAN_REVERSION","Midday-weak");
    if(volatilityExpansion&&trendRegime==="DOWNTREND"&&htfAligned&&marketSession==="US_SESSION"&&volatilityRegime!=="EXTREME_VOL")
        return momentumExhausted?r("NO_TRADE","Exhaustion"):r("MOMENTUM_SHORT","Panic+DOWN");
    if(trendRegime!=="SIDEWAYS"&&(volatilityRegime==="NORMAL_VOL"||volatilityRegime==="HIGH_VOL")){
        if(trendRegime==="DOWNTREND"&&marketSession!=="US_SESSION") return r("NO_TRADE","SHORT→US only");
        const ts=trendRegime==="UPTREND"?"TREND_LONG":"TREND_SHORT",score=marketScore(ts,aBuy,aSell);
        return score>=ROUTER_THRESHOLD?r(ts,`Score ${score}`,score):r("NO_TRADE",`Score ${score}<${ROUTER_THRESHOLD}`); }
    if(trendRegime==="SIDEWAYS"){
        if(Math.abs(emaSlope)>currentATR*0.03) return r("NO_TRADE","Strong slope");
        const score=marketScore("MEAN_REVERSION",aBuy,aSell);
        return score>=ROUTER_THRESHOLD?r("MEAN_REVERSION",`Score ${score}`,score):r("NO_TRADE",`MR ${score}<${ROUTER_THRESHOLD}`); }
    return r("NO_TRADE",`${trendRegime}+${volatilityRegime}`);
}

module.exports = { strategyRouter, marketScore, strategyWinRate, recordStrategyOutcome, recordPerformance, adaptRouterThreshold };
