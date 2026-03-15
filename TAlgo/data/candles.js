"use strict";
const { SYMBOL, INTERVAL, ALMA_LENGTH, EMA_LENGTH, S } = require("../core/state");
const { log } = require("../core/logger");
const { heikinAshi, ema, alma } = require("../market/indicators");
const { detectTrendRegime } = require("../market/classifier");

async function fetchCandles(kc, now){
    if(S.candleCache.length>=40){
        try{
            const recent=await kc.getHistoricalData(SYMBOL.instrument_token,INTERVAL,new Date(now.getTime()-1000*60*15*3),now);
            const newCandle=recent.at(-1);
            if(newCandle&&(!S.candleCache.at(-1)||newCandle.date!==S.candleCache.at(-1).date)){
                S.candleCache.push(newCandle);
                if(S.candleCache.length>200) S.candleCache.shift();
            }
            return S.candleCache;
        }catch(err){
            log(`⚠ Cache append failed (${err.message}) — full fetch`);
            S.candleCache=[];
        }
    }
    const candles=await kc.getHistoricalData(SYMBOL.instrument_token,INTERVAL,new Date(now.getTime()-1000*60*15*200),now);
    S.candleCache=[...candles];
    log(`📥 Full fetch: ${candles.length} candles cached`);
    return candles;
}

async function fetchHtfTrend(kc){
    try{
        const from=new Date(Date.now()-172800000);
        const c1h=await kc.getHistoricalData(SYMBOL.instrument_token,"60minute",from,new Date());
        if(c1h.length<ALMA_LENGTH+2) return;
        const e1h=ema(heikinAshi(c1h).map(x=>x.close),EMA_LENGTH);
        S.htfTrend=detectTrendRegime(c1h.at(-1).close,alma(c1h.map(x=>x.high)).at(-1),alma(c1h.map(x=>x.low)).at(-1),e1h.at(-1)-e1h.at(-2));
        log(`🕐 HTF:${S.htfTrend}`);
    }catch(err){ log(`HTF err:${err.message}`); }
}

module.exports = { fetchCandles, fetchHtfTrend };
