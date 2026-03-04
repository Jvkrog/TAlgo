// ==========================================
// TAlgo v03 – High / Low Zone Logic
// ==========================================
// Objective:
// Divide market into clear trading zones.
//
// Logic:
// Buy above HMA High
// Sell below HMA Low
// Wait or hedge in between.
//
// Outcome:
// Reduced false signals but hedging slowed
// trend recovery.
//
// Learning:
// Hedging protects but delays re-entry.
// ==========================================



function decide(close, hmaHigh, hmaLow) {
  if (close > hmaHigh) {
    return "BUY";
  } else if (close < hmaLow) {
    return "SELL";
  } else {
    return "HEDGE";
  }
}

// example
console.log(decide(370, 375, 365));
