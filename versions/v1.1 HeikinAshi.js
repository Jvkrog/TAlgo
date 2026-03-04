function heikinAshi(prevOpen, prevClose, open, high, low, close) {
  const haClose = (open + high + low + close) / 4;
  const haOpen = (prevOpen + prevClose) / 2;
  return { haOpen, haClose };
}

function decide(haOpen, haClose) {
  return haClose > haOpen ? "BUY" : "SELL";
}
