// ==========================================
// TAlgo v01.1 – Heikin Ashi Smoothing
// ==========================================
// Objective:
// Reduce market noise using Heikin Ashi candles.
//
// Logic:
// Convert normal candles → Heikin Ashi
// Apply same BUY / SELL logic as v01.
//
// Outcome:
// Signals became smoother but still fail in
// sideways markets.
//
// Learning:
// Smoothing alone cannot solve consolidation.
// ==========================================

function heikinAshi(prevOpen, prevClose, open, high, low, close) {
  const haClose = (open + high + low + close) / 4;
  const haOpen = (prevOpen + prevClose) / 2;
  return { haOpen, haClose };
}

function decide(haOpen, haClose) {
  return haClose > haOpen ? "BUY" : "SELL";
}
