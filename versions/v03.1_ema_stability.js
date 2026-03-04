// ==========================================
// TAlgo v03.1 – EMA Stability Layer
// ==========================================
// Objective:
// Improve signal stability.
//
// Logic:
// Use EMA for trend confirmation.
//
// Outcome:
// Fewer whipsaws but slower reaction
// to reversals.
//
// Learning:
// Lag improves stability but hurts transitions.
// ==========================================


function decide(close, emaFast, emaSlow) {
  if (close > emaFast && close > emaSlow) {
    return "BUY";
  } else if (close < emaFast && close < emaSlow) {
    return "SELL";
  } else {
    return "NO_TRADE";
  }
}
