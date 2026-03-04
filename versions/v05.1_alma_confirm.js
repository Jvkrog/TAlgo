// ==========================================
// TAlgo v05.1 – ALMA Confirmation Zone
// ==========================================
// Objective:
// Reduce false trades in sideways markets.
//
// Logic:
// Trade only when price moves clearly
// outside ALMA bands.
//
// Outcome:
// Fewer trades and reduced overtrading.
//
// Learning:
// Explicit transition zones improve
// decision consistency.
// ==========================================

    IF C > ALMA_high AND C > ALMA_low:
        IF position != BUY:
            EXIT position (if any)
            ENTER BUY
            position = BUY

    ELSE IF C < ALMA_high AND C < ALMA_low:
        IF position != SELL:
            EXIT position (if any)
            ENTER SELL
            position = SELL

    ELSE:
        // Price is between ALMA bands
        // No action (transition / sideways phase)
