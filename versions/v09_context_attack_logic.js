// ==========================================
// TAlgo v09 – Context Aware Attack Logic
// ==========================================
// Objective:
// Scale positions only when real momentum exists.
//
// State Machine:
// WAIT → PROBE → ATTACK
//
// Confirmation:
// EMA slope strength
// ALMA bandwidth expansion
//
// Outcome:
// Smarter scaling and fewer false breakouts.
// ==========================================

const SIDEWAYS_BAND = 0.35;
const ATTACK_BAND = 0.6;
const MAX_LOTS = 2;
const LOT_VALUE = 5000;

let position = null;
let entryPrice = 0;
let lots = 0;
let sessionPnL = 0;
let state = "WAIT";

function exitTrade(price){
    if(!position) return;

    const pnl = (price - entryPrice) * lots * LOT_VALUE * (position === "LONG" ? 1 : -1);
    sessionPnL += pnl;

    console.log(`EXIT ${position} ${lots} @ ${price}`);
    console.log(`TradePnL: ${pnl} | SessionPnL: ${sessionPnL}`);

    position = null;
    lots = 0;
    state = "WAIT";
}

function decision(price, almaHigh, almaLow, emaSlope){

    const bandWidth = almaHigh - almaLow;
    const sideways = bandWidth < SIDEWAYS_BAND;
    const strongTrend = Math.abs(emaSlope) > 0.02 && bandWidth > ATTACK_BAND;

    if(state === "WAIT"){

        if(sideways) return;

        if(price > almaHigh){
            position = "LONG";
            entryPrice = price;
            lots = 1;
            state = "PROBE";
            console.log("PROBE LONG");
        }
        else if(price < almaLow){
            position = "SHORT";
            entryPrice = price;
            lots = 1;
            state = "PROBE";
            console.log("PROBE SHORT");
        }
    }

    else if(state === "PROBE"){

        if(sideways){
            exitTrade(price);
            return;
        }

        if(strongTrend && lots < MAX_LOTS){
            lots++;
            state = "ATTACK";
            console.log("ATTACK ADD LOT");
        }

        if(position === "LONG" && price < almaHigh)
            exitTrade(price);

        if(position === "SHORT" && price > almaLow)
            exitTrade(price);
    }

    else if(state === "ATTACK"){

        if(position === "LONG" && price < almaHigh)
            exitTrade(price);

        if(position === "SHORT" && price > almaLow)
            exitTrade(price);
    }
}
