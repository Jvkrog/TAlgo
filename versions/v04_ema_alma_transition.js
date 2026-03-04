// ==========================================
// TAlgo v04 – EMA + ALMA Transition Logic
// ==========================================
// Objective:
// Improve behavior during trend transitions.
//
// Logic:
// EMA → trend direction
// ALMA → smoother breakout levels.
//
// Outcome:
// Improved stability but still weak during
// strong sideways markets.
//
// Learning:
// Transition handling is the hardest problem.
// ==========================================



function decide(close, ema, alma) {
  if (close > ema && close > alma) {
    return "TREND_BUY";
  }

  if (close < ema && close < alma) {
    return "TREND_SELL";
  }

  return "TRANSITION_NO_TRADE";
}

// example
console.log(decide(372, 368, 370));
