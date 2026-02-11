const KiteConnect = require("kiteconnect").KiteConnect;
const KiteTicker = require("kiteconnect").KiteTicker;
const fs = require("fs");
require("dotenv").config();

// ================= CONFIG =================
const API_KEY = process.env.API_KEY;
const ACCESS_TOKEN = fs.readFileSync("access_code.txt","utf8").trim();

const kc = new KiteConnect({ api_key: API_KEY });
kc.setAccessToken(ACCESS_TOKEN);

const ticker = new KiteTicker({
    api_key: API_KEY,
    access_token: ACCESS_TOKEN
});

const SYMBOL = {
    tradingsymbol: "ZINC26FEBFUT",
    exchange: "MCX",
    instrument_token: 122155783
};

const INTERVAL = "15minute";
const ALMA_LENGTH = 20;
const ALMA_OFFSET = 0.85;
const ALMA_SIGMA = 6;

let candles = [];

// ===== SESSION STATE =====
let position = null;        // BUY / SELL
let entryPrice = 0;
let sessionPL = 0;
let maxDrawdown = 0;
let peakPL = 0;
let firstTradeDone = false;
let cooldown = false;
let cooldownCounter = 0;
let lotSize = 1;

// ================= HEIKIN ASHI =================
function heikinAshi(data){
    let ha=[];
    for(let i=0;i<data.length;i++){
        let c=data[i];
        if(i===0){
            ha.push({
                open:(c.open+c.close)/2,
                close:(c.open+c.high+c.low+c.close)/4,
                high:c.high,
                low:c.low
            });
        }else{
            ha.push({
                open:(ha[i-1].open+ha[i-1].close)/2,
                close:(c.open+c.high+c.low+c.close)/4,
                high:c.high,
                low:c.low
            });
        }
    }
    return ha;
}

// ================= ALMA =================
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

// ================= BOOTSTRAP =================
async function bootstrap(){
    let now=new Date();
    let from=new Date(now.getTime()-(1000*60*60*72));

    candles=await kc.getHistoricalData(
        SYMBOL.instrument_token,
        INTERVAL,
        from,
        now
    );

    console.log("Historical Loaded:",candles.length);
}

// ================= DECISION =================
function decisionEngine(){

    if(candles.length < ALMA_LENGTH+5) return;

    let ha=heikinAshi(candles);
    let haClose=ha.map(x=>x.close);
    let almaHigh=alma(ha.map(x=>x.high));
    let almaLow=alma(ha.map(x=>x.low));

    if(almaHigh.length===0) return;

    let price=haClose[haClose.length-1];
    let upper=almaHigh[almaHigh.length-1];
    let lower=almaLow[almaLow.length-1];

    let signal="HOLD";

    if(price>upper) signal="BUY";
    else if(price<lower) signal="SELL";

    // ===== COOL DOWN LOGIC =====
    if(cooldown){
        cooldownCounter++;
        if(cooldownCounter>=2){
            cooldown=false;
            cooldownCounter=0;
            console.log("Cooldown ended. Re-enter allowed.");
        }else{
            signal="HOLD";
        }
    }

    // ===== POSITION LOGIC =====
    if(position===null && signal!=="HOLD"){
        position=signal;
        entryPrice=price;
        firstTradeDone=true;
        console.log("ENTRY",signal,"@",price);
    }

    else if(position==="BUY" && signal==="SELL"){
        let profit=(price-entryPrice)*lotSize;
        updatePL(profit);
        position="SELL";
        entryPrice=price;
        console.log("REVERSE to SELL Profit:",profit.toFixed(2));
    }

    else if(position==="SELL" && signal==="BUY"){
        let profit=(entryPrice-price)*lotSize;
        updatePL(profit);
        position="BUY";
        entryPrice=price;
        console.log("REVERSE to BUY Profit:",profit.toFixed(2));
    }

    console.log(
        new Date().toLocaleTimeString(),
        "Price:",price.toFixed(2),
        "Upper:",upper.toFixed(2),
        "Lower:",lower.toFixed(2),
        "Signal:",signal,
        "Session P&L:",sessionPL.toFixed(2),
        "Drawdown:",maxDrawdown.toFixed(2)
    );
}

// ================= P&L UPDATE =================
function updatePL(p){
    sessionPL+=p;

    if(sessionPL>peakPL) peakPL=sessionPL;

    let dd=peakPL-sessionPL;
    if(dd>maxDrawdown) maxDrawdown=dd;

    if(p<0){
        cooldown=true;
        lotSize=1;   // adaptive safe mode
        console.log("Loss detected. Cooldown activated.");
    }
}

// ================= TIMER =================
function trade_timer(){
    setTimeout(()=>{

        let now=new Date();

        if(now.getHours()>=9 && now.getHours()<23){
            if(now.getMinutes()%15===0 && now.getSeconds()===10){
                decisionEngine();
            }
        }

        if(now.getHours()===23 && now.getMinutes()===45){
            console.log("Session End | Final P&L:",sessionPL.toFixed(2));
            process.exit();
        }

        trade_timer();

    },1000);
}

// ================= WEBSOCKET =================
ticker.on("ticks",ticks=>{
    if(candles.length>0){
        candles[candles.length-1].close=ticks[0].last_price;
    }
});

ticker.on("connect",()=>{
    ticker.subscribe([SYMBOL.instrument_token]);
    ticker.setMode(ticker.modeLTP,[SYMBOL.instrument_token]);
});

// ================= START =================
(async()=>{
    await bootstrap();
    ticker.connect();
    trade_timer();
})();