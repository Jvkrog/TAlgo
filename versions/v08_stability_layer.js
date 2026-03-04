// ==========================================
// TAlgo v08 – Stability Reinforcement Layer
// ==========================================
// Objective:
// Avoid trading during sideways compression.
//
// Logic:
// Measure ALMA band width.
// If band compresses → exit trades.
//
// Outcome:
// Reduced losses during sideways markets.
//
// Learning:
// Stability is more important than aggression.
// ==========================================

const SIDEWAYS_BAND = 0.35;
const MAX_LOTS = 2;
const LOT_VALUE = 5000;

let position = null;
let entryPrice = 0;
let lots = 0;
let sessionPnL = 0;

function exitTrade(price){
    if(!position) return;

    const pnl = (price - entryPrice) * lots * LOT_VALUE * (position === "LONG" ? 1 : -1);
    sessionPnL += pnl;

    console.log(`EXIT ${position} ${lots} @ ${price}`);
    console.log(`TradePnL: ${pnl} | SessionPnL: ${sessionPnL}`);

    position = null;
    lots = 0;
}

function decision(price, almaHigh, almaLow){

    const bandWidth = almaHigh - almaLow;

    if(bandWidth < SIDEWAYS_BAND){
        if(position) exitTrade(price);
        return;
    }

    if(!position){
        if(price > almaHigh){
            position = "LONG";
            entryPrice = price;
            lots = 1;
            console.log("ENTER LONG");
        }
        else if(price < almaLow){
            position = "SHORT";
            entryPrice = price;
            lots = 1;
            console.log("ENTER SHORT");
        }
    }
    else{
        if(position === "LONG" && price < almaHigh)
            exitTrade(price);

        if(position === "SHORT" && price > almaLow)
            exitTrade(price);
    }
}
