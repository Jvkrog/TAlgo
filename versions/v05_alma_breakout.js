// ==========================================
// TAlgo v05 – ALMA Breakout Study
// ==========================================
// Objective:
// Observe pure breakout behavior.
//
// Logic:
// Buy if Close > ALMA High
// Sell if Close < ALMA Low
//
// No stoploss
// No hedging
//
// Outcome:
// Clear trend signals but losses during
// transitions.
//
// Learning:
// Transition losses are unavoidable.
// ==========================================


    IF C > ALMA_high:
        IF position != BUY:
            EXIT position (if any)
            ENTER BUY
            position = BUY

    ELSE IF C < ALMA_low:
        IF position != SELL:
            EXIT position (if any)
            ENTER SELL
            position = SELL
