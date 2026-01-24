IF trading_enabled == true:

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