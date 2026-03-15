"use strict";
const { CAPITAL, BASE_DAILY_RISK, TRAIL_DD_PERCENT, COOLDOWN_DURATION_MS, RISK_STATE, S } = require("./state");
const { log, sendTelegram } = require("./logger");

function propGuards(){
    if(S.riskState===RISK_STATE.HARD_HALT) log("Guard:HARD_HALT");
    if(S.riskState===RISK_STATE.COOL_DOWN){
        const msg=S.cooldownCandles>0?`${S.cooldownCandles}c left`:`${Math.ceil((COOLDOWN_DURATION_MS-(Date.now()-S.cooldownStartTime))/60000)}m left`;
        log(`Guard:COOL_DOWN — ${msg}`); return false; }
    return true;
}

function evaluateRiskState(){
    const equity=CAPITAL+S.sessionPnL; S.equityHigh=Math.max(S.equityHigh,equity);
    const base=CAPITAL*BASE_DAILY_RISK, dl=Math.max(base*0.5,base*(S.currentATR/10));
    if(S.sessionPnL<-dl*1.5||(S.equityHigh-equity)>=CAPITAL*TRAIL_DD_PERCENT){
        if(S.riskState!==RISK_STATE.HARD_HALT){
            S.riskState=RISK_STATE.HARD_HALT; log("🔴 HARD HALT");
            sendTelegram(`🔴 HARD HALT\nPnL:${S.sessionPnL.toFixed(0)}\n${S.sessionPnL<=-dl*1.5?"DL×1.5":"TrailDD"}`); }
        return; }
    if(S.riskState===RISK_STATE.COOL_DOWN){
        if(S.cooldownCandles>0){
            if(--S.cooldownCandles<=0){ S.riskState=RISK_STATE.DEFENSE; S.defenseLossCount=0; log("🟡 Spike→DEFENSE"); sendTelegram("🟡 SpikeCD→DEFENSE"); }
        } else if(Date.now()-S.cooldownStartTime>=COOLDOWN_DURATION_MS){
            S.riskState=RISK_STATE.DEFENSE; S.previousATR=S.currentATR; S.defenseLossCount=0; log("🟡 Loss→DEFENSE"); sendTelegram("🟡 CD→DEFENSE"); }
        return; }
    if(S.riskState===RISK_STATE.NORMAL&&S.sessionPnL<=-(CAPITAL*0.01)){
        S.riskState=RISK_STATE.DEFENSE; S.defenseLossCount=0; log("🟡→DEFENSE"); sendTelegram(`🟡 DEFENSE\nPnL:${S.sessionPnL.toFixed(0)}`); return; }
    if(S.riskState===RISK_STATE.DEFENSE&&S.sessionPnL>-(CAPITAL*0.0025)){
        S.riskState=RISK_STATE.RECOVERY; S.recoveryWinCount=0; log("🔵→RECOVERY"); sendTelegram(`🔵 RECOVERY\nPnL:${S.sessionPnL.toFixed(0)}`); return; }
    if(S.riskState===RISK_STATE.RECOVERY&&S.sessionPnL<=-(CAPITAL*0.0025)){
        S.riskState=RISK_STATE.DEFENSE; S.defenseLossCount=0; log("🟡 RECOVERY stalled"); sendTelegram(`🟡 RECOVERY stalled\nPnL:${S.sessionPnL.toFixed(0)}`); }
}

module.exports = { propGuards, evaluateRiskState };
