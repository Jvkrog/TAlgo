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
