function decide(close, emaFast, emaSlow) {
  if (close > emaFast && close > emaSlow) {
    return "BUY";
  } else if (close < emaFast && close < emaSlow) {
    return "SELL";
  } else {
    return "NO_TRADE";
  }
}
