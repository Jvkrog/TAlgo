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
