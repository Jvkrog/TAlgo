const KiteConnect = require("kiteconnect").KiteConnect;
const KiteTicker = require("kiteconnect").KiteTicker;
const fs = require("fs");

// ===== CONFIG =====
require("dotenv").config();
const API_KEY = process.env.API_KEY;
const ACCESS_TOKEN = fs.readFileSync("access_code.txt","utf8").trim();

const SYMBOL = {
    tradingsymbol: "ZINC26FEBFUT",
    exchange: "MCX",
    instrument_token: 122155783
};

const INTERVAL = "15minute";
const EMA_LENGTH = 20;
const ALMA_LENGTH = 20;
const ALMA_OFFSET = 0.85;
const ALMA_SIGMA = 6;

const LOT_VALUE = 5000;
const MAX_LOTS = 2;

// ===== KITE =====
const kc = new KiteConnect({ api_key: API_KEY });
kc.setAccessToken(ACCESS_TOKEN);

const ticker = new KiteTicker({
    api_key: API_KEY,
    access_token: ACCESS_TOKEN
});

// ===== GLOBAL STATE =====
let candles = [];
let position = 0;
let entryPrice = 0;
let lots = 0;

// ===== EMA =====
function ema(values, period){
    let k = 2/(period+1);
    let emaArr = [values[0]];
    for(let i=1;i<values.length;i++){
        emaArr.push(values[i]*k + emaArr[i-1]*(1-k));
    }
    return emaArr;
}

// ===== ALMA =====
function alma(values){
    const m = ALMA_OFFSET*(ALMA_LENGTH-1);
    const s = ALMA_LENGTH/ALMA_SIGMA;
    let result=[];
    for(let i=ALMA_LENGTH-1;i<values.length;i++){
        let sum=0,norm=0;
        for(let j=0;j<ALMA_LENGTH;j++){
            let w=Math.exp(-((j-m)**2)/(2*s*s));
            sum+=values[i-ALMA_LENGTH+1+j]*w;
            norm+=w;
        }
        result.push(sum/norm);
    }
    return result;
}

// ===== Heikin Ashi =====
function heikinAshi(data){
    let ha=[];
    for(let i=0;i<data.length;i++){
        let c=data[i];
        if(i===0){
            ha.push({
                open:(c.open+c.close)/2,
                close:(c.open+c.high+c.low+c.close)/4
            });
        }else{
            ha.push({
                open:(ha[i-1].open+ha[i-1].close)/2,
                close:(c.open+c.high+c.low+c.close)/4
            });
        }
    }
    return ha;
}

// ===== BOOTSTRAP =====
async function bootstrap(){
    let now=new Date();
    let from=new Date(now.getTime()-(1000*60*60*48));

    candles=await kc.getHistoricalData(
        SYMBOL.instrument_token,
        INTERVAL,
        from,
        now
    );

    console.log("Bootstrap:", candles.length);
}

// ===== DECISION ENGINE =====
function decisionEngine(){

    if(candles.length < ALMA_LENGTH+5) return;

    let ha = heikinAshi(candles);
    let haClose = ha.map(x=>x.close);

    let emaArr = ema(haClose, EMA_LENGTH);
    let almaHigh = alma(candles.map(x=>x.high));
    let almaLow = alma(candles.map(x=>x.low));

    let price = candles[candles.length-1].close;

    let state="SIDEWAYS";
    if(price > almaHigh[almaHigh.length-1] &&
       price > emaArr[emaArr.length-1]){
        state="TREND";
    }
    else if(price < almaLow[almaLow.length-1] &&
            price < emaArr[emaArr.length-1]){
        state="TREND";
    }
    else if(price > almaHigh[almaHigh.length-1] ||
            price < almaLow[almaLow.length-1]){
        state="BREAKOUT";
    }

    // ===== LOT CONTROL =====
    if(state==="TREND") lots=2;
    else if(state==="BREAKOUT") lots=1;
    else lots=0;

    if(lots > MAX_LOTS) lots = MAX_LOTS;

    console.log(new Date().toLocaleTimeString(),
        "Price:", price,
        "State:", state,
        "Lots:", lots);
}

// ===== TIMER =====
function trade_timer(){
    setTimeout(()=>{

        let now=new Date();

        if(now.getHours()>=9 && now.getHours()<23){
            if(now.getMinutes()%15===0 && now.getSeconds()===10){
                decisionEngine();
            }
        }

        if(now.getHours()===23 && now.getMinutes()===45){
            console.log("Shutdown");
            process.exit();
        }

        trade_timer();
    },1000);
}

// ===== WEBSOCKET =====
ticker.on("ticks",ticks=>{
    if(candles.length>0)
        candles[candles.length-1].close=ticks[0].last_price;
});

ticker.on("connect",()=>{
    ticker.subscribe([SYMBOL.instrument_token]);
    ticker.setMode(ticker.modeLTP,[SYMBOL.instrument_token]);
});

// ===== START =====
(async()=>{
    await bootstrap();
    ticker.connect();
    trade_timer();
})();