"use strict";
// Portfolio manager — sits above individual symbol engines.
// Owns: total exposure, shared risk state, capital allocation per symbol.
// Symbol engines call canOpenTrade() before entry and registerTrade()/closeTrade() on fills.
//
// KEY DESIGN DECISION: riskState is SHARED across all symbols.
// If any symbol triggers DEFENSE, all symbols reduce to 1-lot.
// This prevents the portfolio from scaling into correlated drawdowns.

const { isCorrelated } = require("./correlation");

const CAPITAL           = 100000;
const MAX_PORTFOLIO_RISK = 0.05;   // 5% of capital max total open risk
const RISK_PER_SYMBOL    = 0.02;   // 2% capital allocated per symbol
const STOP_MULT          = 1.2;    // stop is typically 1.2× ATR, not exactly 1× ATR

// Registry: symbol tradingsymbol → { symbol config, position, direction }
const registry = {};
let portfolioRiskState = "NORMAL"; // NORMAL | DEFENSE | HARD_HALT — shared across all engines
let totalOpenRisk      = 0;

function registerSymbol(symbolConfig){
    registry[symbolConfig.tradingsymbol] = {
        symbol:    symbolConfig,
        position:  null,       // "LONG" | "SHORT" | null
        direction: 0,          // 1 | -1 | 0
        riskUsed:  0
    };
}

// Called by a symbol engine before entering a trade.
// Returns { allowed, lots } — lots may be reduced by correlation or portfolio cap.
function canOpenTrade(tradingsymbol, direction, requestedLots, atr, lotMultiplier){
    if(portfolioRiskState === "HARD_HALT") return { allowed: false, reason: "Portfolio HARD_HALT" };

    // Correlation check — reduce size instead of blocking outright
    let lots = requestedLots;
    for(const [sym, entry] of Object.entries(registry)){
        if(sym === tradingsymbol) continue;
        if(entry.direction === direction && isCorrelated(tradingsymbol, sym)){
            lots = Math.max(1, Math.floor(lots / 2));
        }
    }

    // Portfolio-level risk cap — uses STOP_MULT for realistic stop distance
    const tradeRisk = atr * STOP_MULT * lots * lotMultiplier;
    if(totalOpenRisk + tradeRisk > CAPITAL * MAX_PORTFOLIO_RISK)
        return { allowed: false, reason: `Portfolio risk cap: ${(totalOpenRisk/CAPITAL*100).toFixed(1)}% used` };

    // Defense mode: all symbols cap to 1 lot
    if(portfolioRiskState === "DEFENSE") lots = 1;
    return { allowed: true, lots };
}

function registerTrade(tradingsymbol, direction, lots, atr, lotMultiplier){
    if(!registry[tradingsymbol]) return;
    registry[tradingsymbol].position  = direction === 1 ? "LONG" : "SHORT";
    registry[tradingsymbol].direction = direction;
    registry[tradingsymbol].riskUsed  = atr * STOP_MULT * lots * lotMultiplier;
    totalOpenRisk += registry[tradingsymbol].riskUsed;
}

function closeTrade(tradingsymbol){
    if(!registry[tradingsymbol]) return;
    totalOpenRisk = Math.max(0, totalOpenRisk - registry[tradingsymbol].riskUsed);
    registry[tradingsymbol].position  = null;
    registry[tradingsymbol].direction = 0;
    registry[tradingsymbol].riskUsed  = 0;
}

// Symbol engines call this when their local PnL triggers state changes.
// Portfolio adopts the worst state of any single symbol.
function updatePortfolioRiskState(symbolRiskState){
    const priority = { NORMAL:0, RECOVERY:1, DEFENSE:2, COOL_DOWN:3, HARD_HALT:4 };
    const current  = priority[portfolioRiskState] ?? 0;
    const incoming = priority[symbolRiskState]    ?? 0;
    if(incoming > current) portfolioRiskState = symbolRiskState;
}

function getPortfolioRiskState(){ return portfolioRiskState; }
function getRegistry(){ return registry; }
function getCapitalForSymbol(){ return CAPITAL * RISK_PER_SYMBOL; }

module.exports = {
    registerSymbol, canOpenTrade, registerTrade, closeTrade,
    updatePortfolioRiskState, getPortfolioRiskState,
    getRegistry, getCapitalForSymbol
};
