// ==========================================
// TAlgo v01 – Raw Candle Logic
// ==========================================
// Objective:
// Create the simplest automated trading rule.
//
// Logic:
// If candle closes higher → BUY
// If candle closes lower → SELL
//
// Problem:
// Extremely sensitive to noise.
// Generates too many false signals.
//
// Learning:
// Raw price action needs smoothing.
// ==========================================


function decide(open, close) {
  if (open > close) {
    return "SELL";
  } else {
    return "BUY";
  }
}

// example
console.log(decide(80, 98));
