// ============================================================
// Solana Meme Coin Paper Trading Bot
// Built on top of dump.fun detection engine
// Mode: PAPER TRADING — no real trades, logs everything
// Telegram: sends every detected coin + filter result + P&L
// ============================================================

import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  // RPC — use Helius free tier: https://helius.dev
  RPC_URL: process.env.RPC_URL || "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY",
  WS_URL:  process.env.WS_URL  || "wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY",

  // Telegram
  TELEGRAM_TOKEN:   process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  // Paper trading settings
  PAPER_TRADE_AMOUNT_USD: 5,       // Simulate $5 per trade
  SOL_PRICE_USD: 150,              // Update this manually or fetch live

  // Filter thresholds
  MIN_LIQUIDITY_SOL: 5,            // Ignore coins with < 5 SOL liquidity
  MAX_DEV_BUY_PCT: 10,             // Reject if dev holds > 10% of supply
  REQUIRE_MINT_REVOKED: true,      // Must have mint authority revoked
  MAX_TOP10_WALLET_PCT: 30,        // Reject if top 10 wallets hold > 30%

  // Exit strategy (paper)
  TAKE_PROFIT_1_PCT: 50,           // Sell 50% of position at +50%
  TAKE_PROFIT_2_PCT: 200,          // Sell remaining at +200%
  STOP_LOSS_PCT: -80,              // Cut at -80% (meme coins die fast)
  MAX_HOLD_MINUTES: 30,            // Force exit after 30 minutes

  // Pump.fun program ID
  PUMP_FUN_PROGRAM_ID: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",

  // Log file
  LOG_FILE: "./paper_trades.json",
};

// ── STATE ─────────────────────────────────────────────────────────────────────
let paperTrades    = loadTrades();
let totalPaperPnL  = 0;
let tradesExecuted = 0;
let tradesRejected = 0;
let connection;

// ── LOAD / SAVE TRADES ────────────────────────────────────────────────────────
function loadTrades() {
  try {
    if (fs.existsSync(CONFIG.LOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.LOG_FILE, "utf8"));
      totalPaperPnL  = data.totalPnL  || 0;
      tradesExecuted = data.executed  || 0;
      tradesRejected = data.rejected  || 0;
      console.log(`📂 Loaded ${data.trades?.length || 0} previous trades`);
      return data.trades || [];
    }
  } catch (e) {}
  return [];
}

function saveTrades() {
  fs.writeFileSync(CONFIG.LOG_FILE, JSON.stringify({
    totalPnL:  totalPaperPnL,
    executed:  tradesExecuted,
    rejected:  tradesRejected,
    trades:    paperTrades,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id:    CONFIG.TELEGRAM_CHAT_ID,
          text:       message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      }
    );
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

// ── RUGCHECK API ──────────────────────────────────────────────────────────────
async function runRugcheck(mintAddress) {
  try {
    const res  = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`);
    const data = await res.json();
    return {
      mintRevoked:    data?.mintAuthority === null,
      freezeRevoked:  data?.freezeAuthority === null,
      lpLocked:       data?.markets?.[0]?.lp?.lpLockedPct > 80,
      topHoldersPct:  data?.topHolders?.reduce((a, h) => a + (h.pct || 0), 0) || 0,
      riskLevel:      data?.score || "unknown",
      rugcheckUrl:    `https://rugcheck.xyz/tokens/${mintAddress}`,
    };
  } catch (e) {
    return null;
  }
}

// ── DEXSCREENER PRICE FETCH ───────────────────────────────────────────────────
async function getTokenPrice(mintAddress) {
  try {
    const res  = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
    const data = await res.json();
    const pair = data?.pairs?.[0];
    return {
      priceUsd:  parseFloat(pair?.priceUsd || 0),
      marketCap: parseFloat(pair?.fdv || 0),
      volume24h: parseFloat(pair?.volume?.h24 || 0),
      liquidity: parseFloat(pair?.liquidity?.usd || 0),
    };
  } catch (e) {
    return null;
  }
}

// ── FILTER ENGINE ─────────────────────────────────────────────────────────────
async function runFilters(mintAddress, liquiditySol) {
  const filters = [];
  let passed    = true;

  // Filter 1: Minimum liquidity
  if (liquiditySol < CONFIG.MIN_LIQUIDITY_SOL) {
    filters.push(`❌ Liquidity too low: ${liquiditySol} SOL (min ${CONFIG.MIN_LIQUIDITY_SOL})`);
    passed = false;
  } else {
    filters.push(`✅ Liquidity OK: ${liquiditySol} SOL`);
  }

  // Filter 2-4: Rugcheck
  const rug = await runRugcheck(mintAddress);
  if (rug) {
    if (CONFIG.REQUIRE_MINT_REVOKED && !rug.mintRevoked) {
      filters.push(`❌ Mint NOT revoked — dev can print tokens`);
      passed = false;
    } else {
      filters.push(`✅ Mint revoked`);
    }

    if (!rug.freezeRevoked) {
      filters.push(`❌ Freeze authority NOT revoked`);
      passed = false;
    } else {
      filters.push(`✅ Freeze revoked`);
    }

    if (rug.topHoldersPct > CONFIG.MAX_TOP10_WALLET_PCT) {
      filters.push(`❌ Top holders: ${rug.topHoldersPct.toFixed(1)}% (max ${CONFIG.MAX_TOP10_WALLET_PCT}%)`);
      passed = false;
    } else {
      filters.push(`✅ Top holders OK: ${rug.topHoldersPct.toFixed(1)}%`);
    }

    if (!rug.lpLocked) {
      filters.push(`⚠️ LP not locked (risky but not blocking)`);
    } else {
      filters.push(`✅ LP locked >80%`);
    }
  } else {
    filters.push(`⚠️ Rugcheck unavailable — proceeding with caution`);
  }

  return { passed, filters, rug };
}

// ── PAPER TRADE ENTRY ─────────────────────────────────────────────────────────
async function enterPaperTrade(mintAddress, liquiditySol, entryPrice) {
  const trade = {
    id:            `trade_${Date.now()}`,
    mintAddress,
    entryTime:     new Date().toISOString(),
    entryPrice,
    entryLiqSol:   liquiditySol,
    amountUsd:     CONFIG.PAPER_TRADE_AMOUNT_USD,
    status:        "open",
    exitPrice:     null,
    exitTime:      null,
    pnlUsd:        null,
    pnlPct:        null,
    tp1Hit:        false,
    tp2Hit:        false,
    exitReason:    null,
  };

  paperTrades.push(trade);
  tradesExecuted++;
  saveTrades();

  // Schedule exit monitoring
  monitorTrade(trade);

  return trade;
}

// ── TRADE MONITOR ─────────────────────────────────────────────────────────────
async function monitorTrade(trade) {
  const maxTime   = CONFIG.MAX_HOLD_MINUTES * 60 * 1000;
  const startTime = Date.now();
  let   tp1Done   = false;

  const interval = setInterval(async () => {
    try {
      const priceData = await getTokenPrice(trade.mintAddress);
      if (!priceData || priceData.priceUsd === 0) return;

      const currentPrice = priceData.priceUsd;
      const pnlPct       = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
      const elapsed      = Date.now() - startTime;

      // Take profit 1
      if (!tp1Done && pnlPct >= CONFIG.TAKE_PROFIT_1_PCT) {
        tp1Done = true;
        const partialPnL = (CONFIG.PAPER_TRADE_AMOUNT_USD * 0.5) * (CONFIG.TAKE_PROFIT_1_PCT / 100);
        await sendTelegram(
          `🟡 <b>PAPER TP1 HIT</b>\n` +
          `Token: <code>${trade.mintAddress.slice(0, 12)}...</code>\n` +
          `Sold 50% at +${CONFIG.TAKE_PROFIT_1_PCT}%\n` +
          `Partial profit: +$${partialPnL.toFixed(2)}\n` +
          `<a href="https://dexscreener.com/solana/${trade.mintAddress}">Chart</a>`
        );
      }

      // Take profit 2
      if (pnlPct >= CONFIG.TAKE_PROFIT_2_PCT) {
        clearInterval(interval);
        closeTrade(trade, currentPrice, pnlPct, "TP2");
        return;
      }

      // Stop loss
      if (pnlPct <= CONFIG.STOP_LOSS_PCT) {
        clearInterval(interval);
        closeTrade(trade, currentPrice, pnlPct, "STOP_LOSS");
        return;
      }

      // Time exit
      if (elapsed >= maxTime) {
        clearInterval(interval);
        closeTrade(trade, currentPrice, pnlPct, "TIME_EXIT");
        return;
      }
    } catch (e) {
      // Price fetch failed, keep monitoring
    }
  }, 15000); // Check every 15 seconds
}

// ── CLOSE TRADE ───────────────────────────────────────────────────────────────
async function closeTrade(trade, exitPrice, pnlPct, reason) {
  const pnlUsd = CONFIG.PAPER_TRADE_AMOUNT_USD * (pnlPct / 100);

  trade.exitPrice  = exitPrice;
  trade.exitTime   = new Date().toISOString();
  trade.pnlUsd     = pnlUsd;
  trade.pnlPct     = pnlPct;
  trade.status     = "closed";
  trade.exitReason = reason;

  totalPaperPnL += pnlUsd;
  saveTrades();

  const emoji  = pnlUsd > 0 ? "🟢" : "🔴";
  const stats  = getDailyStats();

  await sendTelegram(
    `${emoji} <b>PAPER TRADE CLOSED</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `Token: <code>${trade.mintAddress.slice(0, 16)}...</code>\n` +
    `Reason: ${reason}\n` +
    `PnL: ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)} (${pnlPct.toFixed(1)}%)\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📊 <b>Today's Stats</b>\n` +
    `Trades: ${stats.total} | Won: ${stats.wins} | Lost: ${stats.losses}\n` +
    `Win Rate: ${stats.winRate}%\n` +
    `Total PnL: ${totalPaperPnL >= 0 ? "+" : ""}$${totalPaperPnL.toFixed(2)}\n` +
    `<a href="https://dexscreener.com/solana/${trade.mintAddress}">Chart</a>`
  );
}

// ── DAILY STATS ───────────────────────────────────────────────────────────────
function getDailyStats() {
  const today  = new Date().toDateString();
  const todays = paperTrades.filter(t =>
    t.status === "closed" && new Date(t.exitTime).toDateString() === today
  );
  const wins   = todays.filter(t => t.pnlUsd > 0).length;
  const losses = todays.filter(t => t.pnlUsd <= 0).length;
  return {
    total:   todays.length,
    wins,
    losses,
    winRate: todays.length ? ((wins / todays.length) * 100).toFixed(0) : 0,
    pnl:     todays.reduce((a, t) => a + t.pnlUsd, 0),
  };
}

// ── NEW TOKEN DETECTED ────────────────────────────────────────────────────────
async function onNewToken(mintAddress, liquiditySol) {
  console.log(`\n🔔 New token detected: ${mintAddress} | Liquidity: ${liquiditySol} SOL`);

  // Run filters
  const { passed, filters, rug } = await runFilters(mintAddress, liquiditySol);

  // Get entry price
  const priceData = await getTokenPrice(mintAddress);
  const entryPrice = priceData?.priceUsd || 0;

  const filterSummary = filters.join("\n");
  const rugUrl = rug?.rugcheckUrl || `https://rugcheck.xyz/tokens/${mintAddress}`;
  const dexUrl = `https://dexscreener.com/solana/${mintAddress}`;

  if (!passed) {
    tradesRejected++;
    saveTrades();

    await sendTelegram(
      `🚫 <b>TOKEN REJECTED</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `<code>${mintAddress.slice(0, 20)}...</code>\n\n` +
      `<b>Filters:</b>\n${filterSummary}\n\n` +
      `<a href="${rugUrl}">Rugcheck</a> | <a href="${dexUrl}">Chart</a>\n` +
      `Rejected today: ${tradesRejected}`
    );
    return;
  }

  // All filters passed — enter paper trade
  const trade = await enterPaperTrade(mintAddress, liquiditySol, entryPrice);

  await sendTelegram(
    `🟢 <b>PAPER TRADE ENTERED</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `<code>${mintAddress}</code>\n\n` +
    `💰 Simulated: $${CONFIG.PAPER_TRADE_AMOUNT_USD}\n` +
    `📈 Entry price: $${entryPrice.toFixed(8)}\n` +
    `💧 Liquidity: ${liquiditySol} SOL\n\n` +
    `<b>Filters:</b>\n${filterSummary}\n\n` +
    `🎯 TP1: +${CONFIG.TAKE_PROFIT_1_PCT}% | TP2: +${CONFIG.TAKE_PROFIT_2_PCT}%\n` +
    `🛑 Stop: ${CONFIG.STOP_LOSS_PCT}% | ⏱ Max: ${CONFIG.MAX_HOLD_MINUTES}min\n\n` +
    `<a href="${rugUrl}">Rugcheck</a> | <a href="${dexUrl}">Chart</a>`
  );
}

// ── WEBSOCKET LISTENER (dump.fun core logic) ──────────────────────────────────
function startListener() {
  connection = new Connection(CONFIG.RPC_URL, "confirmed");

  console.log("🚀 Paper trading bot started");
  console.log(`📡 Listening to Pump.fun on Solana...`);
  console.log(`💵 Simulating $${CONFIG.PAPER_TRADE_AMOUNT_USD} per trade`);
  console.log(`📲 Telegram alerts: ${CONFIG.TELEGRAM_TOKEN ? "ON" : "OFF"}\n`);

  sendTelegram(
    `🚀 <b>Paper Trading Bot Started</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `Mode: PAPER TRADE (no real money)\n` +
    `Amount per trade: $${CONFIG.PAPER_TRADE_AMOUNT_USD}\n` +
    `Filters: Mint revoked ✅ | LP locked ✅ | Top holders ✅\n` +
    `TP1: +${CONFIG.TAKE_PROFIT_1_PCT}% | TP2: +${CONFIG.TAKE_PROFIT_2_PCT}%\n` +
    `Stop loss: ${CONFIG.STOP_LOSS_PCT}%`
  );

  // Subscribe to Pump.fun program logs
  connection.onLogs(
    new PublicKey(CONFIG.PUMP_FUN_PROGRAM_ID),
    async ({ logs, signature }) => {
      try {
        // Detect new token creation
        const isNewToken = logs.some(log =>
          log.includes("InitializeMint") ||
          log.includes("Create") ||
          log.includes("initialize")
        );

        if (!isNewToken) return;

        // Fetch transaction to extract token details
        const tx = await connection.getTransaction(signature, {
          commitment:                  "confirmed",
          maxSupportedTransactionVersion: 0,
        });

        if (!tx) return;

        // Extract mint address (token address)
        const accounts    = tx.transaction.message.staticAccountKeys;
        const mintAddress = accounts?.[1]?.toString();
        if (!mintAddress) return;

        // Extract liquidity from SOL balance changes
        const preBalances  = tx.meta?.preBalances  || [];
        const postBalances = tx.meta?.postBalances || [];
        const solAdded     = Math.abs((postBalances[0] - preBalances[0]) / 1e9);
        const liquiditySol = parseFloat(solAdded.toFixed(4));

        // Deduplicate
        const alreadyTracked = paperTrades.some(t => t.mintAddress === mintAddress);
        if (alreadyTracked) return;

        await onNewToken(mintAddress, liquiditySol);

      } catch (e) {
        // Silently skip failed transactions
      }
    },
    "confirmed"
  );
}

// ── DAILY SUMMARY (sent at midnight UAE = 20:00 UTC) ─────────────────────────
function scheduleDailySummary() {
  const now     = new Date();
  const next8pm = new Date();
  next8pm.setUTCHours(20, 0, 0, 0);
  if (next8pm <= now) next8pm.setUTCDate(next8pm.getUTCDate() + 1);

  setTimeout(async () => {
    const stats = getDailyStats();
    await sendTelegram(
      `📊 <b>Daily Paper Trading Summary</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `Total trades: ${stats.total}\n` +
      `✅ Wins: ${stats.wins} | ❌ Losses: ${stats.losses}\n` +
      `Win rate: ${stats.winRate}%\n` +
      `Today's PnL: ${stats.pnl >= 0 ? "+" : ""}$${stats.pnl.toFixed(2)}\n` +
      `All-time PnL: ${totalPaperPnL >= 0 ? "+" : ""}$${totalPaperPnL.toFixed(2)}\n` +
      `Rejected (rugs avoided): ${tradesRejected}\n\n` +
      `<b>Projected real ($5/trade):</b>\n` +
      `Daily: ${stats.pnl >= 0 ? "+" : ""}$${stats.pnl.toFixed(2)}\n` +
      `Monthly: ${(stats.pnl * 30) >= 0 ? "+" : ""}$${(stats.pnl * 30).toFixed(2)}`
    );
    scheduleDailySummary(); // reschedule for next day
  }, next8pm - now);
}

// ── START ─────────────────────────────────────────────────────────────────────
startListener();
scheduleDailySummary();
