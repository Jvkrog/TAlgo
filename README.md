//Overview

-->TAlgo is a rule-based trading decision system built to reduce emotional bias (fear, greed, revenge trading) in live markets.

//The project focuses on:

-->Decision consistency

-->Behavior during market transitions

-->Learning from failures through iteration

-->Explainability using logs


//This repository documents the evolution of the algorithm, version by version, showing what worked, what failed, and why changes were made.

> Logic > Emotion

---

//v1.0 — Raw Candle Logic

//Objective

-->Create the simplest possible automated decision logic.

//Logic

-->If candle closes lower → SELL

-->If candle closes higher → BUY


//Outcome

-->Too many false signals

-->Highly sensitive to noise

-->Not usable in live markets


//Learning

-->Markets are noisy. Raw price action needs smoothing.


---

//v1.1 — Heikin Ashi Smoothing

//Objective

-->Reduce noise by smoothing candle data.

//Logic

-->Convert candles to Heikin Ashi

-->Apply same buy/sell logic as v1.0


//Outcome

-->Smoother signals

-->Reduced false entries

-->Still fails badly in sideways markets


//Learning

-->Smoothing alone is insufficient during consolidation phases.


---

//v2.0 — HMA Trend Detection

//Objective

-->Capture trend direction more clearly.

//Logic

-->If Close > HMA → BUY

-->Else → SELL


//Outcome

-->Better trend capture

-->Faster response than EMA

-->Continuous flip-flopping during sideways sessions


//Learning

-->Trend indicators fail during transitions without context.


---

//v3.0 — HMA High / Low (Divide & Rule)

//Objective

-->Separate market into trend and transition zones.

//Logic

-->Buy above HMA High

-->Sell below HMA Low

-->Hedge / wait in between


//Outcome

-->Reduced false trades

-->Hedging stayed active too long

-->Profit erosion during recoveries


//Learning

-->Hedging can protect but also delay re-entry unnecessarily.


---

//v3.1 — EMA-Based Trend Stability

//Objective

-->Sacrifice speed for stability.

//Logic

-->Use EMA for trend confirmation

-->Slower entries, cleaner exits


//Outcome

-->Fewer whipsaws

-->Lag caused late exits

-->Small but consistent losses during reversals


//Learning

-->Lag is safer but not optimal during transitions.


---

//v4.0 — EMA + ALMA Transition Handling

//Objective

-->Improve behavior during trend shifts.

//Logic

-->EMA for direction

-->ALMA for smoother transition detection


//Outcome

-->Improved stability

-->Still vulnerable during sharp sideways sessions

-->Complex interaction between indicators


//Learning

-->Transition handling is the hardest problem.


---

//v5.0 — ALMA High / Low (Raw Behavior Study)

//Objective

-->Observe pure decision behavior without safety nets.

//Logic

-->Buy if Close > ALMA High

-->Sell if Close < ALMA Low

-->No stop loss

-->No hedging

-->No profit target


//Outcome

-->Clear trend decisions

-->Acceptable losses during transitions

-->Behavior fully visible in logs


//Learning

-->Losses during transitions are unavoidable and must be understood, not hidden.


---

//v5.1 — ALMA Confirmation Zone

//Objective

-->Reduce false trades during sideways markets.

//Logic

-->Buy only if Close > ALMA High AND ALMA Low

-->Sell only if Close < ALMA High AND ALMA Low

-->No trade in between


//Outcome

-->Fewer trades

-->Reduced overtrading

-->Decision alignment ~70% (post-analysis)


//Learning

-->Explicit transition zones improve consistency.


---
//v5.2 -ALMA with Heikin Ashi 

-->Reintroduced Heikin Ashi Smoothing with ALMA 

---

//v6 Session Aware Explainable Decision System

-->TAlgo v6 introduces session awareness, risk context, and explainable decisions, transforming a signal-based algo into a behavioral trading system.

---

//v7 — Dynamic Trend Commitment
//Objective
-->Improve profit capture during strong trends

-->Maintain safety during sideways markets

//Logic

-->Initial entry uses ALMA band breakout (v5 logic)

-->Position starts with 1 lot 

-->Simple lot scaling when trend confirmed


//Outcome

-->Strong trends captured more effectively

-->Clear behavior visible in logs

//Learning

-->Market rewards commitment after confirmation, not before.

//v8 — Stability Reinforcement Layer

//Objective

-->Reduce behavioral instability after scaling

-->Improve sideways handling without adding complexity


//Logic

-->Retain v7 probe → confirm → scale structure

-->Introduce stricter sideways filter using ALMA bandwidth

-->Exit immediately if bandwidth compresses after entry

-->Limit scaling frequency (no repeated adds)

-->Cleaner session-level logging


//Outcome

-->Fewer unnecessary scale-ins

-->Reduced losses during compression phases

-->Improved behavioral consistency

-->More stable PnL curve during choppy days


//Learning

-->Stability is more important than aggressiveness.

-->Sideways markets must be respected, not fought.


---


//v9 — Context-Aware Attack Logic

//Objective

-->Make scaling conditional on real momentum

-->Prevent premature commitment


//Logic

-->Probe entry at ALMA breakout (v7 base)

-->Confirm using:

   EMA slope strength
   ALMA bandwidth expansion

-->Scale only if:
   Trend strength > threshold
   Bandwidth expanding (volatility expansion)

-->Introduce state machine:
   WAIT → PROBE → ATTACK

-->Exit immediately if expansion fails


//Outcome

-->More intelligent attack timing

-->Reduced scaling in false breakouts

-->Clear separation between testing (probe) and commitment (attack)

-->Behavior became more structured and explainable


//Learning

-->Volatility expansion confirms intent.

-->Commitment should follow evidence, not expectation.

---


TAlgo v10

//Overview

--> TAlgo is a rule-based trading decision system built to reduce emotional bias (fear, greed, revenge trading) in live markets.

--> This version focuses on structured breakout trading using ALMA channels and EMA trend confirmation.

--> The system runs on 15-minute candles and executes trades only when predefined conditions are satisfied.


---

Project Focus

--> Decision consistency

--> Trend breakout detection

--> Simple state-based trade execution

--> Learning from iterative development

--> Transparent behavior through console logs


---

Strategy Idea

--> The algorithm detects price breakouts beyond dynamic ALMA boundaries.

--> Trades are not taken immediately; they pass through a confirmation stage before committing full position size.

--> This prevents false breakouts and reduces impulsive entries.


---

Core Indicators

--> Heikin Ashi

Used to smooth candle noise and improve trend clarity.


---

--> EMA (20)

Used to measure trend direction through slope calculation.


---

--> ALMA (Arnaud Legoux Moving Average)

Used to create upper and lower breakout boundaries for entries.


---

Strategy Flow

WAIT
 ↓
PROBATION
 ↓
CONFIRMED


---

WAIT

--> The system monitors the market for breakouts.

Conditions:

--> Price > ALMA High → Potential LONG

--> Price < ALMA Low → Potential SHORT

Action:

--> Enter 1 lot

State → PROBATION


---

PROBATION

--> Breakout validation stage.

Confirmation rules:

--> LONG requires positive EMA slope

--> SHORT requires negative EMA slope

If confirmed:

--> Add 1 additional lot

If breakout fails:

--> Exit position immediately


---

CONFIRMED

--> Trend management phase.

Exit rules:

--> LONG exits when price falls back below ALMA High

--> SHORT exits when price rises above ALMA Low

This allows the system to ride trends but exit on pullbacks.


---

Execution Timing

--> Strategy runs every 15 minutes.

--> Execution occurs 5 seconds after candle close to ensure completed data.


---

Market Scope

--> Instrument: MCX Zinc Futures

--> Trading hours:

09:00 → 23:00


---

Position Logic

--> Initial entry: 1 lot

--> Confirmation scaling: +1 lot

--> Contract multiplier:

LOT_MULTIPLIER = 5000

PnL calculation:

price difference × lots × multiplier


---

System Design Goals

--> Simple and explainable logic

--> Minimal indicators

--> Structured trade confirmation

--> Clear log-based behavior tracking


---

Limitations (This Version)

--> No drawdown protection

--> No risk state machine

--> No volatility filters

--> No Telegram notifications

--> No tick-level risk control

These protections were introduced in later versions of the engine.


---

Development Philosophy

--> The system evolves through real-market observations and iteration.

--> Each version documents improvements in logic, stability, and risk control.


---

Core Principle

Logic > Emotion


---




