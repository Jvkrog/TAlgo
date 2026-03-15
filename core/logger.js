"use strict";
require("dotenv").config();
const axios = require("axios");
const { SYMBOL, S } = require("./state");

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(msg){
    if(!TELEGRAM_TOKEN||!TELEGRAM_CHAT_ID)return;
    try{ await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        {chat_id:TELEGRAM_CHAT_ID,text:`[${SYMBOL.tradingsymbol}|${SYMBOL.instrument_token}]\n`+msg}); }
    catch{ console.log("Telegram Error"); }
}

const log = msg => console.log(`[${new Date().toLocaleTimeString()}][${S.riskState}] ${msg}`);

function decisionSnapshot(price){
    const{trendRegime,volatilityRegime,marketSession,selectedStrategy,routerScore,marketEnergy,marketPressure,htfTrend,htfAligned,falseBreak}=S;
    log(`📊 SNAP P:${price.toFixed(2)} ${trendRegime} ${volatilityRegime} ${marketSession} strat:${selectedStrategy} score:${routerScore} nrg:${marketEnergy} MPI:${marketPressure} HTF:${htfTrend}(${htfAligned}) FB:${falseBreak}`);
}

function logStrategyStats(){
    log("📈 STATS\n"+Object.entries(S.strategyMemory).map(([s,b])=>
        !b.length?`  ${s.padEnd(16)} -`:`  ${s.padEnd(16)} ${(b.reduce((a,v)=>a+v,0)/b.length*100).toFixed(0)}%(${b.length}t)`
    ).join("\n"));
}

const fs = require("fs");
const ACCESS_FILE_PATH="access_code.txt";
const ACCESS_TOKEN=fs.readFileSync(ACCESS_FILE_PATH,"utf8").trim();
const tokenDate=new Date(fs.statSync(ACCESS_FILE_PATH).mtime).toLocaleString();

function startupHealthCheck(){
    return ["🩺 Health",process.env.API_KEY?"✅ Key":"❌ Key",ACCESS_TOKEN?"✅ Token":"❌ Token",
        (TELEGRAM_TOKEN&&TELEGRAM_CHAT_ID)?"✅ TG":"⚠ TG",`🕒 ${tokenDate}`].join("\n");
}

module.exports = { sendTelegram, log, decisionSnapshot, logStrategyStats, startupHealthCheck, ACCESS_TOKEN, tokenDate };
