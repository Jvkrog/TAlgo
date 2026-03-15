"use strict";
// Static correlation map — update after observing live price behavior.
// These are approximate MCX energy/metal correlations; tune from your own log data.
const CORRELATION = {
    "NATGASMINI26MARFUT_ZINC26MARFUT": 0.15,   // low — different fundamentals
    "ZINC26MARFUT_NATGASMINI26MARFUT": 0.15,
};
const HIGH_CORRELATION_THRESHOLD = 0.65;

// Returns true if both symbols are in the same direction AND highly correlated.
// Call this before opening a second position to avoid doubling correlated risk.
function isCorrelated(sym1, sym2){
    const key = `${sym1}_${sym2}`;
    return (CORRELATION[key] ?? 0) >= HIGH_CORRELATION_THRESHOLD;
}

// Returns a size multiplier (0.5) when correlation is moderate, 0 when high.
function correlationSizeMult(sym1, sym2){
    const c = CORRELATION[`${sym1}_${sym2}`] ?? 0;
    if(c >= HIGH_CORRELATION_THRESHOLD) return 0;    // block
    if(c >= 0.45)                        return 0.5;  // halve
    return 1;
}

module.exports = { isCorrelated, correlationSizeMult };
