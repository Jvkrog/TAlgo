IF trading_enabled == true:

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