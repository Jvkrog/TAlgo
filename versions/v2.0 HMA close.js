function decide(close, hma) {
  if (close > hma) {
    return "BUY";
  } else {
    return "SELL";
  }
}

// example
console.log(decide(372, 365));
