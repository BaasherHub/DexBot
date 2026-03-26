// ============================================================
// Solana Meme Coin Paper Trading Bot v2
// Fixes: rate limiting, fast reject, dedup, 429 prevention
// ============================================================

import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const CONFIG = {
  RPC_URL: process.env.RPC_URL || "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY",
  WS_URL:  process.env.WS_URL  || "wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY",

  TELEGRAM_TOKEN:   process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  PAPER_TRADE_AMOUNT_USD: 5,
  SOL_PRICE_USD:          150,

  // Filters
  FAST_REJECT_SOL: parseInt(process.env.MIN_LIQUIDITY_SOL) || 5, // Match full filter — no API calls below this
  MIN_LIQUIDITY_SOL:   5,     // Full filter minimum
  REQUIRE_MINT_REVOKED: true,
  MAX_TOP10_WALLET_PCT: 30,

  // Exit
  TAKE_PROFIT_1_PCT:  50,
  TAKE_PROFIT_2_PCT:  200,
  STOP_LOSS_PCT:      -80,
  MAX_HOLD_MINUTES:   30,

  // Rate limiting
  QUEUE_DELAY_MS: parseInt(process.env.QUEUE_DELAY_MS) || 5000,   // 1 token per 2 seconds max
  DEDUP_TTL_MS:    60000,  // Forget seen tokens after 60s

  PUMP_FUN_PROGRAM_ID: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  LOG_FILE: "./paper_trades.json",
};

// State
let paperTrades    = loadTrades();
let totalPaperPnL  = 0;
let tradesExecuted = 0;
let tradesRejected = 0;
let connection;
const seenTokens   = new Map();
const tokenQueue   = [];
let   isProcessing = false;

function loadTrades() {
  try {
    if (fs.existsSync(CONFIG.LOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.LOG_FILE, "utf8"));
      totalPaperPnL  = data.totalPnL  || 0;
      tradesExecuted = data.executed  || 0;
      tradesRejected = data.rejected  || 0;
      console.log(`Loaded ${data.trades?.length || 0} previous trades`);
      return data.trades || [];
    }
  } catch (e) {}
  return [];
}

function saveTrades() {
  fs.writeFileSync(CONFIG.LOG_FILE, JSON.stringify({
    totalPnL: totalPaperPnL, executed: tradesExecuted,
    rejected: tradesRejected, trades: paperTrades,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

async function sendTelegram(message) {
  if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message,
        parse_mode: "HTML", disable_web_page_preview: true,
      }),
    });
  } catch (e) { console.error("Telegram error:", e.message); }
}

async function runRugcheck(mintAddress) {
  try {
    const res  = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`);
    const data = await res.json();
    return {
      mintRevoked:   data?.mintAuthority === null,
      freezeRevoked: data?.freezeAuthority === null,
      lpLocked:      data?.markets?.[0]?.lp?.lpLockedPct > 80,
      topHoldersPct: data?.topHolders?.reduce((a, h) => a + (h.pct || 0), 0) || 0,
    };
  } catch (e) { return null; }
}

async function getTokenPrice(mintAddress) {
  try {
    const res  = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
    const data = await res.json();
    const pair = data?.pairs?.[0];
    return { priceUsd: parseFloat(pair?.priceUsd || 0) };
  } catch (e) { return null; }
}

async function runFilters(mintAddress, liquiditySol) {
  const filters = [];
  let passed = true;

  // Liquidity check first — return early, no extra API calls
  if (liquiditySol < CONFIG.MIN_LIQUIDITY_SOL) {
    filters.push(`Liquidity too low: ${liquiditySol} SOL (min ${CONFIG.MIN_LIQUIDITY_SOL})`);
    return { passed: false, filters, rug: null };
  }
  filters.push(`Liquidity OK: ${liquiditySol} SOL`);

  // Only call Rugcheck if liquidity passed
  const rug = await runRugcheck(mintAddress);
  if (rug) {
    if (CONFIG.REQUIRE_MINT_REVOKED && !rug.mintRevoked) {
      filters.push(`Mint NOT revoked`); passed = false;
    } else { filters.push(`Mint revoked`); }

    if (!rug.freezeRevoked) {
      filters.push(`Freeze NOT revoked`); passed = false;
    } else { filters.push(`Freeze revoked`); }

    if (rug.topHoldersPct > CONFIG.MAX_TOP10_WALLET_PCT) {
      filters.push(`Top holders: ${rug.topHoldersPct.toFixed(1)}% (too high)`); passed = false;
    } else { filters.push(`Top holders OK: ${rug.topHoldersPct.toFixed(1)}%`); }

    filters.push(rug.lpLocked ? `LP locked >80%` : `LP not locked (warning)`);
  } else {
    filters.push(`Rugcheck unavailable`);
  }

  return { passed, filters, rug };
}

async function enterPaperTrade(mintAddress, liquiditySol, entryPrice) {
  const trade = {
    id: `trade_${Date.now()}`, mintAddress,
    entryTime: new Date().toISOString(), entryPrice,
    entryLiqSol: liquiditySol, amountUsd: CONFIG.PAPER_TRADE_AMOUNT_USD,
    status: "open", exitPrice: null, exitTime: null,
    pnlUsd: null, pnlPct: null, exitReason: null,
  };
  paperTrades.push(trade);
  tradesExecuted++;
  saveTrades();
  monitorTrade(trade);
  return trade;
}

async function monitorTrade(trade) {
  const maxTime = CONFIG.MAX_HOLD_MINUTES * 60 * 1000;
  const startTime = Date.now();
  let tp1Done = false;

  const interval = setInterval(async () => {
    try {
      const priceData = await getTokenPrice(trade.mintAddress);
      if (!priceData || priceData.priceUsd === 0) return;
      const pnlPct = ((priceData.priceUsd - trade.entryPrice) / trade.entryPrice) * 100;

      if (!tp1Done && pnlPct >= CONFIG.TAKE_PROFIT_1_PCT) {
        tp1Done = true;
        const partial = (CONFIG.PAPER_TRADE_AMOUNT_USD * 0.5) * (CONFIG.TAKE_PROFIT_1_PCT / 100);
        await sendTelegram(
          `🟡 <b>TP1 HIT</b> — <code>${trade.mintAddress.slice(0,12)}...</code>\n` +
          `Sold 50% at +${CONFIG.TAKE_PROFIT_1_PCT}% → +$${partial.toFixed(2)}\n` +
          `<a href="https://dexscreener.com/solana/${trade.mintAddress}">Chart</a>`
        );
      }
      if (pnlPct >= CONFIG.TAKE_PROFIT_2_PCT) {
        clearInterval(interval); await closeTrade(trade, priceData.priceUsd, pnlPct, "TP2");
      } else if (pnlPct <= CONFIG.STOP_LOSS_PCT) {
        clearInterval(interval); await closeTrade(trade, priceData.priceUsd, pnlPct, "STOP_LOSS");
      } else if (Date.now() - startTime >= maxTime) {
        clearInterval(interval); await closeTrade(trade, priceData.priceUsd, pnlPct, "TIME_EXIT");
      }
    } catch (e) {}
  }, 15000);
}

async function closeTrade(trade, exitPrice, pnlPct, reason) {
  const pnlUsd = CONFIG.PAPER_TRADE_AMOUNT_USD * (pnlPct / 100);
  Object.assign(trade, {
    exitPrice, exitTime: new Date().toISOString(),
    pnlUsd, pnlPct, status: "closed", exitReason: reason,
  });
  totalPaperPnL += pnlUsd;
  saveTrades();

  const today  = new Date().toDateString();
  const todays = paperTrades.filter(t => t.status === "closed" && new Date(t.exitTime).toDateString() === today);
  const wins   = todays.filter(t => t.pnlUsd > 0).length;

  await sendTelegram(
    `${pnlUsd > 0 ? "🟢" : "🔴"} <b>TRADE CLOSED — ${reason}</b>\n` +
    `<code>${trade.mintAddress.slice(0,16)}...</code>\n` +
    `PnL: ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)} (${pnlPct.toFixed(1)}%)\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `Today: ${todays.length} trades | ${wins}W ${todays.length - wins}L\n` +
    `All-time: ${totalPaperPnL >= 0 ? "+" : ""}$${totalPaperPnL.toFixed(2)}\n` +
    `<a href="https://dexscreener.com/solana/${trade.mintAddress}">Chart</a>`
  );
}

// Rate-limited queue processor
async function processQueue() {
  if (isProcessing || tokenQueue.length === 0) return;
  isProcessing = true;

  const { mintAddress, liquiditySol } = tokenQueue.shift();
  console.log(`Processing: ${mintAddress} | ${liquiditySol} SOL | Queue left: ${tokenQueue.length}`);

  try {
    const { passed, filters, rug } = await runFilters(mintAddress, liquiditySol);
    const summary = filters.map(f => f).join("\n");
    const rugUrl  = `https://rugcheck.xyz/tokens/${mintAddress}`;
    const dexUrl  = `https://dexscreener.com/solana/${mintAddress}`;

    if (!passed) {
      tradesRejected++;
      saveTrades();
      // Only alert on Telegram for coins that passed liquidity (others are just spam)
      if (liquiditySol >= CONFIG.MIN_LIQUIDITY_SOL) {
        await sendTelegram(
          `🚫 <b>REJECTED</b>\n<code>${mintAddress.slice(0,20)}...</code>\n${summary}\n` +
          `<a href="${rugUrl}">Rugcheck</a> | <a href="${dexUrl}">Chart</a>`
        );
      }
    } else {
      const priceData  = await getTokenPrice(mintAddress);
      const entryPrice = priceData?.priceUsd || 0;
      await enterPaperTrade(mintAddress, liquiditySol, entryPrice);
      await sendTelegram(
        `🟢 <b>PAPER TRADE ENTERED</b>\n` +
        `<code>${mintAddress}</code>\n\n` +
        `💰 $${CONFIG.PAPER_TRADE_AMOUNT_USD} | 📈 $${entryPrice.toFixed(8)} | 💧 ${liquiditySol} SOL\n\n` +
        `${summary}\n\n` +
        `🎯 TP1 +${CONFIG.TAKE_PROFIT_1_PCT}% | TP2 +${CONFIG.TAKE_PROFIT_2_PCT}% | 🛑 ${CONFIG.STOP_LOSS_PCT}%\n` +
        `<a href="${rugUrl}">Rugcheck</a> | <a href="${dexUrl}">Chart</a>`
      );
    }
  } catch (e) { console.error("Queue error:", e.message); }

  isProcessing = false;
  if (tokenQueue.length > 0) setTimeout(processQueue, CONFIG.QUEUE_DELAY_MS);
}

function onNewTokenRaw(mintAddress, liquiditySol) {
  const now = Date.now();

  // Dedup
  if (seenTokens.has(mintAddress)) return;
  seenTokens.set(mintAddress, now);

  // Clean old dedup entries
  if (seenTokens.size > 500) {
    for (const [k, v] of seenTokens.entries()) {
      if (now - v > CONFIG.DEDUP_TTL_MS) seenTokens.delete(k);
    }
  }

  // Fast reject without API call
  if (liquiditySol < CONFIG.FAST_REJECT_SOL) {
    console.log(`Fast reject: ${mintAddress} — ${liquiditySol} SOL`);
    return;
  }

  tokenQueue.push({ mintAddress, liquiditySol });
  console.log(`Queued: ${mintAddress} | ${liquiditySol} SOL | Queue: ${tokenQueue.length}`);
  if (!isProcessing) processQueue();
}

function startListener() {
  connection = new Connection(CONFIG.RPC_URL, {
    commitment: "confirmed",
    wsEndpoint: CONFIG.WS_URL,
  });

  console.log("🚀 Solana Paper Trading Bot v2 started");
  console.log(`⚡ Fast reject: < ${CONFIG.FAST_REJECT_SOL} SOL`);
  console.log(`🔍 Full filter: >= ${CONFIG.MIN_LIQUIDITY_SOL} SOL`);
  console.log(`⏱  Queue delay: ${CONFIG.QUEUE_DELAY_MS}ms`);
  console.log(`📲 Telegram: ${CONFIG.TELEGRAM_TOKEN ? "ON" : "OFF"}\n`);

  sendTelegram(
    `🚀 <b>Paper Bot v2 Started</b>\n` +
    `Fast reject: &lt;${CONFIG.FAST_REJECT_SOL} SOL\n` +
    `Full filter: &gt;=${CONFIG.MIN_LIQUIDITY_SOL} SOL\n` +
    `Per trade: $${CONFIG.PAPER_TRADE_AMOUNT_USD}\n` +
    `TP1: +${CONFIG.TAKE_PROFIT_1_PCT}% | TP2: +${CONFIG.TAKE_PROFIT_2_PCT}% | Stop: ${CONFIG.STOP_LOSS_PCT}%`
  );

  // Signature queue — throttles getTransaction calls to avoid 429s
  const sigQueue = [];
  let sigProcessing = false;

  async function processSigQueue() {
    if (sigProcessing || sigQueue.length === 0) return;
    sigProcessing = true;
    const signature = sigQueue.shift();
    try {
      const tx = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (tx) {
        const mintAddress = tx.transaction.message.staticAccountKeys?.[1]?.toString();
        if (mintAddress) {
          const pre  = tx.meta?.preBalances  || [];
          const post = tx.meta?.postBalances || [];
          const liq  = parseFloat(Math.abs((post[0] - pre[0]) / 1e9).toFixed(4));
          onNewTokenRaw(mintAddress, liq);
        }
      }
    } catch (e) {}
    sigProcessing = false;
    if (sigQueue.length > 0) setTimeout(processSigQueue, 300); // max ~3 getTransaction/sec
  }

  connection.onLogs(
    new PublicKey(CONFIG.PUMP_FUN_PROGRAM_ID),
    ({ logs, signature }) => {
      const isNew = logs.some(l => l.includes("InitializeMint") || l.includes("Create") || l.includes("initialize"));
      if (!isNew) return;
      if (sigQueue.length > 20) return; // Drop if queue too long — old events are stale anyway
      sigQueue.push(signature);
      if (!sigProcessing) processSigQueue();
    },
    "confirmed"
  );
}

// Daily summary at midnight UAE (20:00 UTC)
function scheduleDailySummary() {
  const next = new Date();
  next.setUTCHours(20, 0, 0, 0);
  if (next <= new Date()) next.setUTCDate(next.getUTCDate() + 1);

  setTimeout(async () => {
    const today  = new Date().toDateString();
    const todays = paperTrades.filter(t => t.status === "closed" && new Date(t.exitTime).toDateString() === today);
    const wins   = todays.filter(t => t.pnlUsd > 0).length;
    const pnl    = todays.reduce((a, t) => a + t.pnlUsd, 0);

    await sendTelegram(
      `📊 <b>Daily Summary</b>\n━━━━━━━━━━━━━━━━━━\n` +
      `Trades: ${todays.length} | ✅ ${wins} | ❌ ${todays.length - wins}\n` +
      `Win rate: ${todays.length ? ((wins/todays.length)*100).toFixed(0) : 0}%\n` +
      `Today: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}\n` +
      `All-time: ${totalPaperPnL >= 0 ? "+" : ""}$${totalPaperPnL.toFixed(2)}\n` +
      `Rugs avoided: ${tradesRejected}\n\n` +
      `<b>Monthly projection:</b> ${(pnl*30) >= 0 ? "+" : ""}$${(pnl*30).toFixed(2)}`
    );
    scheduleDailySummary();
  }, next - new Date());
}

startListener();
scheduleDailySummary();
