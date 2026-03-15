"use strict";
require("dotenv").config();

const { startMarketFeed } = require("./data/marketFeed");
const { strategyLoop, startLifecycle } = require("./core/engine");
const { log } = require("./core/logger");

// Boot sequence
startMarketFeed();   // WebSocket ticks + orderflow
startLifecycle();    // HTF updater + 23:00/23:15 lifecycle

// 15m strategy loop — fires every second, self-deduplicates by slot
setInterval(() => strategyLoop().catch(err => log("ERR:" + err.message)), 1000);
