// ==========================================
// TAlgo v02 – HMA Trend Detection
// ==========================================
// Objective:
// Capture market trend direction clearly.
//
// Logic:
// Close > HMA → BUY
// Close < HMA → SELL
//
// Outcome:
// Good during trends but flips repeatedly
// during sideways markets.
//
// Learning:
// Trend indicators need context.
// ==========================================

function decide(close, hma) {
  if (close > hma) {
    return "BUY";
  } else {
    return "SELL";
  }
}

// example
console.log(decide(372, 365));
