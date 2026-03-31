# TAlgo — Adaptive Real-Time Trading Engine

Real-time trading system built on an event-driven architecture with deterministic decision logic.

Markets evolve constantly. 

No trading strategy remains profitable forever.

TAlgo is not built around a fixed strategy —  it is built around a **permanent adaptive framework**.

Strategies may fail. The framework survives.


> Final production logic implemented in v11 — ALMA Fast Color Engine

![Version](https://img.shields.io/badge/version-v11-skyblue)
![Strategy](https://img.shields.io/badge/strategy-ColorBasedDecision-white)
![Market](https://img.shields.io/badge/market-MCX-darkred)
![Language](https://img.shields.io/badge/language-Node.js-lightgreen)



---

## Overview

TAlgo is a rule-based trading engine designed to eliminate emotional decision-making (fear, greed, revenge trading) and replace it with structured, explainable logic.

The system processes live market data, constructs candles, computes indicators, and executes trades in real time.
```
WebSocket → Tick → Candle → Indicators → Strategy → Execution

```
---


## Key Features
```
- Real-time market data processing (WebSocket)
- Event-driven architecture (non-blocking)
- In-memory OHLC computation (low latency)
- Indicator-driven strategy (EMA, HMA, ALMA)
- State-based decision system
- Fully explainable behavior via logs
```
---

## Documentation

Detailed system documentation:
```
-  [Kite Integration](docs/kite-integration.md)
-  [Architecture](docs/architecture.md)
-  [Strategy](docs/strategy.md)
```
---

## System Summary
```
- **Strategy Type:** Breakout + Confirmation  
- **Market:** MCX Zinc Futures  
- **Execution:** 1hr candles  
- **Core Goal:** Consistent and explainable trading behavior  
```
---

## Repository Structure

TAlgo/ ├── docs/ │   ├── kite-integration.md │   ├── architecture.md │   └── strategy.md ├── versions/       → Algorithm evolution (v01 → v11) ├── PineScript/     → TradingView prototypes └── README.md

---

## Algorithm Evolution
```
- The system evolved through structured experimentation.  
- Each version addresses a specific failure observed in real market behavior.
```
---

### v01 — Raw Candle Logic
```
**Objective**
- Simplest automated rule

**Outcome**
- High noise, unusable

**Learning**
- Raw price action is unreliable
```
---

### v01.1 — Heikin Ashi
```
**Objective**
- Reduce noise

**Learning**
- Smoothing alone is insufficient
```
---

### v02 — HMA Trend
```
**Objective**
- Detect trend direction

**Learning**
- Trend indicators fail in sideways markets
```
---

### v03 — Zone Logic
```
**Objective**
- Separate trend vs transition

**Learning**
- Protection slows recovery
```
---

### v04 — EMA + ALMA
```
**Objective**
- Improve transitions

**Learning**
- Transitions are hardest problem
```
---

### v05–v05.1 — ALMA Breakout
```
**Objective**
- Study breakout behavior

**Learning**
- Transition losses are inevitable
```
---

### v06 — Session Engine
```
**Features**
- Session tracking
- PnL awareness
- Cooldown logic
- Logging

**Learning**
- Systems require session context
```
---
```
### v07 — Dynamic Commitment

**Logic**
- Scale after confirmation

**Learning**
- Markets reward validated aggression
```
---

### v08 — Stability Layer
```
**Logic**
- Exit during compression

**Learning**
- Stability > aggressiveness
```
---

### v09 — Context-Aware Engine
```
WAIT → PROBE → ATTACK

**Learning**
- Volatility confirms intent
```
---
```
### v10 — Structured Breakout
```
WAIT → PROBATION → CONFIRMED
```
**Learning**
- Structured phases improve discipline
```
---

### v11 — ALMA Fast Engine (Production)
```
**Logic**
- ALMA slope → direction  
- ALMA band → sideways  

**Outcome**
- Cleaner signals  
- Reduced overtrading  

**Learning**
- Simplicity beats complexity
```
---

## Strategy Evolution

```mermaid

v1[v01] --> v2[v02]
v2 --> v3[v03]
v3 --> v4[v04]
v4 --> v5[v05]
v5 --> v6[v06]
v6 --> v7[v07]
v7 --> v8[v08]
v8 --> v9[v09]
v9 --> v10[v10]
v10 --> v11[v11]

```
---

### Development Philosophy

TAlgo evolves through:
```
- Real market observation

- Iterative improvements

- Behavioral analysis

- Continuous refinement
```

The goal is not just profitability, but consistent and explainable decision-making.


---

### Research Insights

## Market Noise
```
- Early versions overreacted

- Solution: smoothing + filtering

```
## Sideways Markets
```
- Frequent losses

- Solution: ALMA bands
```

## Market Transitions
```
- Major loss source

- Solution: staged decision systems

```
## Overcommitment
```
- Large losses on false breakouts

- Solution: gradual scaling
```

## Stability
```
- Compression caused instability

- Solution: bandwidth filters

```

---

## System Flow


A[Market Data] --> B[Candle Processing]
B --> C[Indicators]
C --> D[Decision Engine]
D --> E[State Machine]
E --> F[Execution]
F --> G[Logs]


---

## Decision States



A[WAIT] --> B[PROBATION]
B --> C[CONFIRMED]
B --> A
C --> A


---

## Final Summary
```
ALMA → Filter
EMA  → Bias
HMA  → Confirmation

Candle → Indicators → Signal → Execution
```
TAlgo is designed for:
```
- low latency

- deterministic execution

- real-time responsiveness

```

---

Author

Developed by Jvkrog

Focused on:
```
- real-time trading systems

- behavioral market analysis

- algorithmic strategy design
```

---
