# Strategy — TAlgo

## Overview

TAlgo uses a structured, indicator-driven strategy to generate deterministic trading decisions based on market conditions.

The strategy is designed to:
```
- identify trends
- filter sideways markets
- reduce false signals
- maintain consistent behavior under live conditions
```
---

## Strategy Pipeline
```
OHLC → Indicators → Market State → Signal → Execution
```
---

## Core Indicators

### EMA (Trend Bias)
```
- Used to determine short-term directional bias
- Reacts quickly to price changes
```
```javascript
const ema = EMA(ohlc.close, 20);

```
---

### HMA (Early Trend Detection)
```
- Faster than EMA

- Detects early trend shifts

- Used for confirmation
```
```javascript
const hma = HMA(ohlc.close, 16);

```
---

## ALMA (Market Filter)
```
- Smooth and noise-resistant

- Identifies market condition (trend vs sideways)
```
```javascript
const alma = ALMA(ohlc.close, 9);

```
---

### Indicator Roles
```
- ALMA → Market condition filter
- EMA  → Direction bias
- HMA  → Confirmation / early movement

```
---

### Market State Detection

The system classifies the market into:
```
1. Trending Market

- ALMA shows clear slope

- EMA aligns with price direction


2. Sideways Market

- ALMA is flat

- Price oscillates around EMA

```
---

### Decision Logic
```javascript
function signal(close, ema, hma, alma) {

  // Bullish condition
  if (close > ema && hma > alma) {
    return "BUY";
  }

  // Bearish condition
  if (close < ema && hma < alma) {
    return "SELL";
  }

  // No clear signal
  return "NO_TRADE";
}

```
---

### Strategy Design
```
- Multi-Layer Filtering

- ALMA filters market noise

- EMA defines direction

- HMA confirms movement

```

---

### Deterministic Logic
```
- Same inputs always produce same output

- No randomness or subjective rules

```

---

### Noise Reduction
```
- Avoid trades during sideways conditions

- Prevent false breakouts
```


---

### Execution Timing
```
- Signals are evaluated only after candle close

- Prevents intra-candle noise and false triggers

```

---

### Risk Awareness (Basic)

Current strategy focuses on:
```
- signal quality over frequency

- avoiding overtrading

```
### Future extensions
```
- position sizing

- drawdown control

- stop-loss logic
```
---

### Strengths
```
- Simple but structured

- Works well in trending markets

- Reduces noise using ALMA filtering

- Deterministic and explainable

```

---

### Limitations
```
- May miss early breakouts

- Reduced performance in choppy markets

- Depends on parameter tuning
```


---

### Summary
```
- ALMA → Filter
- EMA  → Bias
- HMA  → Confirmation
```
Final flow:
```
Candle → Indicators → Market State → Signal → Order
```
The strategy is designed to balance:
```
- responsiveness

- stability

- clarity of decision-making
```

---

