# TAlgo Strategy

Market: MCX Zinc Futures  
Execution: 15 minute candles  
Strategy Type: Breakout + confirmation  

Indicators:
- Heikin Ashi smoothing
- EMA trend slope
- ALMA breakout boundaries

State Machine:
WAIT → PROBATION → CONFIRMED

Entry Logic:
Price breaks ALMA boundary.

Confirmation Logic:
EMA slope confirms trend direction.

Position Logic:
Initial entry → 1 lot  
Confirmation → add lot  

Exit Logic:
Price re-enters ALMA band.
