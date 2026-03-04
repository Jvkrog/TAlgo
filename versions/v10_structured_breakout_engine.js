require("dotenv").config();

const { KiteConnect } = require("kiteconnect");
const fs = require("fs");

// ===== CONFIG =====
const API_KEY = process.env.API_KEY;
const ACCESS_TOKEN = fs.readFileSync("access_code.txt","utf8").trim();

const SYMBOL = {
    tradingsymbol: "ZINC26MARFUT",
    exchange: "MCX",
    instrument_token: 124841479
};

const INTERVAL = "15minute";
const ALMA_LENGTH = 20;
const ALMA_OFFSET = 0.85;
const ALMA_SIGMA = 6;
const EMA_LENGTH = 20;

const LOT_MULTIPLIER = 5000;

// ===== STATE =====
let position = null;
let lotSize = 0;
let state = "WAIT";
let entryPrice = 0;
let sessionPnL = 0;

let sessionLogged = false;

let kc = new KiteConnect({ api_key: API_KEY });
kc.setAccessToken(ACCESS_TOKEN);

// ===== LOG FUNCTION =====
function log(msg){
    const t = new Date().toLocaleTimeString();
    console.log(`[${t}] ${msg}`);
}

// ===== STARTUP BANNER =====
(function startupBanner(){
    const now = new Date();
    log("====================================");
    log("TAlgo Engine Started");
    log("Time: " + now.toLocaleString());

    if(now.getHours() < 9)
        log("Status: Waiting for market session");
    else if(now.getHours() < 23)
        log("Status: Market ACTIVE");
    else
        log("Status: After market hours");

    log("====================================");
})();

// ===== HEIKIN ASHI =====
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

// ===== EMA =====
function ema(values,length){
    let result=[];
    let k=2/(length+1);
    let prev=values[0];
    result.push(prev);
    for(let i=1;i<values.length;i++){
        let cur=values[i]*k+prev*(1-k);
        result.push(cur);
        prev=cur;
    }
    return result;
}

// ===== ALMA =====
function alma(values){
    const m=ALMA_OFFSET*(ALMA_LENGTH-1);
    const s=ALMA_LENGTH/ALMA_SIGMA;
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

// ===== EXIT =====
function exitPosition(price){

    let pnl = position==="LONG"
        ? (price-entryPrice)
        : (entryPrice-price);

    pnl *= lotSize * LOT_MULTIPLIER;
    sessionPnL += pnl;

    log(`EXIT ${position} ${lotSize} LOT @ ${price}`);
    log(`TradePnL: ${pnl.toFixed(0)} | SessionPnL: ${sessionPnL.toFixed(0)}`);

    position=null;
    lotSize=0;
    state="WAIT";
    entryPrice=0;
}

// ===== DECISION ENGINE =====
function decisionEngine(price, almaHigh, almaLow, emaSlope){

    let phase="SIDEWAYS";
    if(price>almaHigh && emaSlope>0) phase="UPTREND";
    else if(price<almaLow && emaSlope<0) phase="DOWNTREND";

    log(`Price:${price} | ALMA-H:${almaHigh.toFixed(2)} | ALMA-L:${almaLow.toFixed(2)} | Phase:${phase}`);

    if(state==="WAIT"){
        if(price>almaHigh){
            position="LONG";
            lotSize=1;
            entryPrice=price;
            state="PROBATION";
            log(`ENTER LONG 1 LOT @ ${price}`);
        }
        else if(price<almaLow){
            position="SHORT";
            lotSize=1;
            entryPrice=price;
            state="PROBATION";
            log(`ENTER SHORT 1 LOT @ ${price}`);
        }
    }

    else if(state==="PROBATION"){
        if(position==="LONG"){
            if(price>almaHigh && emaSlope>0){
                lotSize=2;
                state="CONFIRMED";
                log("ADD 1 LOT LONG (TREND CONFIRMED)");
            }
            else if(price<almaHigh){
                exitPosition(price);
            }
        }

        if(position==="SHORT"){
            if(price<almaLow && emaSlope<0){
                lotSize=2;
                state="CONFIRMED";
                log("ADD 1 LOT SHORT (TREND CONFIRMED)");
            }
            else if(price>almaLow){
                exitPosition(price);
            }
        }
    }

    else if(state==="CONFIRMED"){
        if(position==="LONG" && price<almaHigh) exitPosition(price);
        if(position==="SHORT" && price>almaLow) exitPosition(price);
    }
}

// ===== MAIN LOOP =====
async function run(){

    const now=new Date();

    // session open log once
    if(now.getHours()===9 && now.getMinutes()<15 && !sessionLogged){
        log("***** MARKET SESSION OPEN *****");
        sessionLogged=true;
    }

    // market hours only
    if(now.getHours()<9 || now.getHours()>=23){
        return;
    }

    // every 15 min candle sync
    //if(now.getMinutes()%15!==0) return;
	const candleMinute = now.getMinutes();

    if (candleMinute % 15 !== 0 || now.getSeconds() !== 5) return;

    let from=new Date(now.getTime()-(1000*60*60*24*7));

    const candles=await kc.getHistoricalData(
        SYMBOL.instrument_token,
        INTERVAL,
        from,
        now
    );

    const ha=heikinAshi(candles);
    const haClose=ha.map(x=>x.close);

    const emaValues=ema(haClose,EMA_LENGTH);
    const emaSlope=emaValues.at(-1)-emaValues.at(-2);

    const almaHigh=alma(candles.map(x=>x.high)).at(-1);
    const almaLow=alma(candles.map(x=>x.low)).at(-1);

    const price=candles.at(-1).close;

    log(`Candle Time: ${now.toLocaleTimeString()}`);

    decisionEngine(price, almaHigh, almaLow, emaSlope);
}

// ===== LOOP =====
setInterval(()=>{

    const now=new Date();

    // shutdown & summary
    if(now.getHours()===23 && now.getMinutes()===0){
        log("===== SESSION CLOSED =====");
        log(`FINAL SESSION P&L: ${sessionPnL.toFixed(0)}`);
        process.exit();
    }

    run().catch(err=>log("ERROR: "+err.message));

}, 1000);
