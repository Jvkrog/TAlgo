function decide(open, close) {
  if (open > close) {
    return "SELL";
  } else {
    return "BUY";
  }
}

// example
console.log(decide(80, 98));
