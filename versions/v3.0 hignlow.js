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
