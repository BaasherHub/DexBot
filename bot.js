// ============================================================
// Solana DEX Paid Paper Trading Bot
// Trigger: DexScreener DEX Paid tokens (dev paid for listing)
// Filters: Rugcheck (mint, freeze, holders)
// Exit: TP1 +30%, TP2 +60%, Moon bag 20%, Stop -40%
// Price: Pump.fun bonding curve (real-time)
// ============================================================

import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import WebSocket from "ws";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  // Helius RPC — only used for bonding curve price reads
  RPC_URL: process.env.RPC_URL || "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY",

  TELEGRAM_TOKEN:   process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  PAPER_TRADE_AMOUNT_USD: 5,
  SOL_PRICE_USD: parseFloat(process.env.SOL_PRICE_USD) || 150,

  // Filters
  MIN_LIQUIDITY_USD:    1000,   // Min $1000 liquidity
  REQUIRE_MINT_REVOKED: true,
  REQUIRE_FREEZE_REVOKED: true,
  MAX_TOP10_WALLET_PCT: 30,

  // Exit strategy
  TP1_PCT:          30,    // Alert: sell 50%
  TP2_PCT:          60,    // Alert: sell 30%
  MOON_BAG_PCT:     20,    // Keep 20%, stop tracking after 2hrs
  STOP_LOSS_PCT:    -40,   // Alert: exit all

  // Polling
  DEX_POLL_INTERVAL_MS:   60000,   // Check DexScreener every 60s
  PRICE_CHECK_MS:         10000,   // Check price every 10s per position
  DEDUP_TTL_MS:           3600000, // Don't re-alert same token for 1 hour

  LOG_FILE: "./dexpaid_trades.json",

  // Pump.fun bonding curve
  PUMP_PROGRAM_ID: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
};

// ── STATE ─────────────────────────────────────────────────────────────────────
let trades       = loadTrades();
let totalPnL     = 0;
let totalEntered = 0;
let totalRejected = 0;
let connection;
const seenTokens = new Map(); // mint -> timestamp

// ── LOAD / SAVE ───────────────────────────────────────────────────────────────
function loadTrades() {
  try {
    if (fs.existsSync(CONFIG.LOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.LOG_FILE, "utf8"));
      totalPnL      = data.totalPnL      || 0;
      totalEntered  = data.totalEntered  || 0;
      totalRejected = data.totalRejected || 0;
      console.log(`📂 Loaded ${data.trades?.length || 0} previous trades`);
      return data.trades || [];
    }
  } catch (e) {}
  return [];
}

function saveTrades() {
  fs.writeFileSync(CONFIG.LOG_FILE, JSON.stringify({
    totalPnL, totalEntered, totalRejected,
    trades,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (e) { console.error("Telegram error:", e.message); }
}

// ── DEXSCREENER — FETCH DEX PAID TOKENS ──────────────────────────────────────
async function fetchDexPaidTokens() {
  try {
    // DexScreener boosted/paid tokens endpoint
    const res  = await fetch("https://api.dexscreener.com/token-boosts/latest/v1");
    const data = await res.json();

    if (!Array.isArray(data)) return [];

    // Filter for Solana only
    return data.filter(token =>
      token.chainId === "solana" &&
      token.tokenAddress
    );
  } catch (e) {
    console.error("DexScreener fetch error:", e.message);
    return [];
  }
}

// ── DEXSCREENER — FETCH TOKEN DETAILS ────────────────────────────────────────
async function fetchTokenDetails(mintAddress) {
  try {
    const res  = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
    const data = await res.json();
    const pair = data?.pairs?.[0];
    if (!pair) return null;

    return {
      name:        pair.baseToken?.name || "Unknown",
      symbol:      pair.baseToken?.symbol || "???",
      priceUsd:    parseFloat(pair.priceUsd || 0),
      marketCap:   parseFloat(pair.fdv || 0),
      liquidity:   parseFloat(pair.liquidity?.usd || 0),
      volume24h:   parseFloat(pair.volume?.h24 || 0),
      priceChange: parseFloat(pair.priceChange?.h1 || 0),
      age:         pair.pairCreatedAt
        ? Math.floor((Date.now() - pair.pairCreatedAt) / 60000)
        : null,
    };
  } catch (e) { return null; }
}

// ── RUGCHECK ──────────────────────────────────────────────────────────────────
async function runRugcheck(mintAddress) {
  try {
    const res  = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`);
    const data = await res.json();
    return {
      mintRevoked:   data?.mintAuthority === null,
      freezeRevoked: data?.freezeAuthority === null,
      lpLocked:      data?.markets?.[0]?.lp?.lpLockedPct > 80,
      topHoldersPct: data?.topHolders?.reduce((a, h) => a + (h.pct || 0), 0) || 0,
      score:         data?.score || 0,
    };
  } catch (e) { return null; }
}

// ── BONDING CURVE PRICE ───────────────────────────────────────────────────────
const PUMP_PROGRAM_PUBKEY           = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_CURVE_SEED               = Buffer.from("bonding-curve");
const VIRTUAL_SOL_RESERVES_OFFSET   = 40;
const VIRTUAL_TOKEN_RESERVES_OFFSET = 48;

function findBondingCurveAddress(mintPubkey) {
  return PublicKey.findProgramAddressSync(
    [PUMP_CURVE_SEED, mintPubkey.toBuffer()],
    PUMP_PROGRAM_PUBKEY
  )[0];
}

async function getPumpFunPrice(mintAddress) {
  try {
    const mintPubkey  = new PublicKey(mintAddress);
    const curveAddr   = findBondingCurveAddress(mintPubkey);
    const accountInfo = await connection.getAccountInfo(curveAddr);
    if (!accountInfo?.data) return null;

    const data = accountInfo.data;
    const virtualSolReserves   = Number(data.readBigUInt64LE(VIRTUAL_SOL_RESERVES_OFFSET))  / 1e9;
    const virtualTokenReserves = Number(data.readBigUInt64LE(VIRTUAL_TOKEN_RESERVES_OFFSET)) / 1e6;
    if (virtualTokenReserves === 0) return null;

    const priceInSol = virtualSolReserves / virtualTokenReserves;
    const priceUsd   = priceInSol * CONFIG.SOL_PRICE_USD;
    return { priceUsd, priceInSol };
  } catch (e) {
    // Fallback to DexScreener price
    try {
      const details = await fetchTokenDetails(mintAddress);
      return details?.priceUsd > 0 ? { priceUsd: details.priceUsd } : null;
    } catch (e2) { return null; }
  }
}

// ── RUN FILTERS ───────────────────────────────────────────────────────────────
async function runFilters(mintAddress, liquidity) {
  const filters = [];
  let passed = true;

  // Liquidity check
  if (liquidity < CONFIG.MIN_LIQUIDITY_USD) {
    filters.push(`❌ Liquidity too low: $${liquidity.toFixed(0)} (min $${CONFIG.MIN_LIQUIDITY_USD})`);
    return { passed: false, filters, rug: null };
  }
  filters.push(`✅ Liquidity: $${liquidity.toLocaleString()}`);

  // Rugcheck
  const rug = await runRugcheck(mintAddress);
  if (rug) {
    if (CONFIG.REQUIRE_MINT_REVOKED && !rug.mintRevoked) {
      filters.push(`❌ Mint NOT revoked`); passed = false;
    } else { filters.push(`✅ Mint revoked`); }

    if (CONFIG.REQUIRE_FREEZE_REVOKED && !rug.freezeRevoked) {
      filters.push(`❌ Freeze NOT revoked`); passed = false;
    } else { filters.push(`✅ Freeze revoked`); }

    if (rug.topHoldersPct > CONFIG.MAX_TOP10_WALLET_PCT) {
      filters.push(`❌ Top holders: ${rug.topHoldersPct.toFixed(1)}% (max ${CONFIG.MAX_TOP10_WALLET_PCT}%)`);
      passed = false;
    } else { filters.push(`✅ Top holders: ${rug.topHoldersPct.toFixed(1)}%`); }

    filters.push(rug.lpLocked ? `✅ LP locked >80%` : `⚠️ LP not locked`);
  } else {
    filters.push(`⚠️ Rugcheck unavailable`);
  }

  return { passed, filters, rug };
}

// ── ENTER PAPER TRADE ─────────────────────────────────────────────────────────
async function enterTrade(mintAddress, tokenDetails) {
  const priceData  = await getPumpFunPrice(mintAddress);
  const entryPrice = priceData?.priceUsd || tokenDetails?.priceUsd || 0;

  const trade = {
    id:          `trade_${Date.now()}`,
    mintAddress,
    name:        tokenDetails?.name || "Unknown",
    symbol:      tokenDetails?.symbol || "???",
    entryPrice,
    entryTime:   new Date().toISOString(),
    amountUsd:   CONFIG.PAPER_TRADE_AMOUNT_USD,
    status:      "open",
    tp1Hit:      false,
    tp2Hit:      false,
    slHit:       false,
    exitPrice:   null,
    exitTime:    null,
    pnlUsd:      null,
    pnlPct:      null,
    exitReason:  null,
  };

  trades.push(trade);
  totalEntered++;
  saveTrades();
  monitorTrade(trade);
  return { trade, entryPrice };
}

// ── MONITOR TRADE ─────────────────────────────────────────────────────────────
async function monitorTrade(trade) {
  const startTime = Date.now();
  let tp1Done = false;

  const interval = setInterval(async () => {
    try {
      const pos = trades.find(t => t.id === trade.id);
      if (!pos || pos.status !== "open") { clearInterval(interval); return; }

      const priceData = await getPumpFunPrice(pos.mintAddress);
      if (!priceData || priceData.priceUsd === 0) return;

      // Update entry price if it was 0
      if (pos.entryPrice === 0) {
        pos.entryPrice = priceData.priceUsd;
        saveTrades();
        return;
      }

      const pnlPct  = ((priceData.priceUsd - pos.entryPrice) / pos.entryPrice) * 100;
      const elapsed = Date.now() - startTime;
      const axiomUrl = `https://axiom.trade/t/${pos.mintAddress}`;
      const dexUrl   = `https://dexscreener.com/solana/${pos.mintAddress}`;
      const pumpUrl  = `https://pump.fun/coin/${pos.mintAddress}`;
      const links    = `<a href="${pumpUrl}">Pump.fun</a> | <a href="${axiomUrl}">Axiom</a> | <a href="${dexUrl}">Chart</a>`;

      // TP1 +30%
      if (!tp1Done && pnlPct >= CONFIG.TP1_PCT) {
        tp1Done = true;
        pos.tp1Hit = true;
        saveTrades();
        await sendTelegram(
          `🎯 <b>TP1 HIT — SELL 50% NOW</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `<b>${pos.name}</b> (${pos.symbol})\n` +
          `📈 +${pnlPct.toFixed(1)}%\n` +
          `💰 Sell 50% on Axiom immediately\n` +
          `💡 Now playing with house money\n\n${links}`
        );
      }

      // TP2 +60%
      if (pos.tp1Hit && !pos.tp2Hit && pnlPct >= CONFIG.TP2_PCT) {
        pos.tp2Hit = true;
        saveTrades();
        await sendTelegram(
          `🚀 <b>TP2 HIT — SELL 30% NOW</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `<b>${pos.name}</b> (${pos.symbol})\n` +
          `📈 +${pnlPct.toFixed(1)}%\n` +
          `💰 Sell 30% on Axiom\n` +
          `🌙 Keep 20% as moon bag\n\n${links}`
        );
      }

      // Stop loss -40%
      if (!pos.slHit && pnlPct <= CONFIG.STOP_LOSS_PCT) {
        pos.slHit  = true;
        pos.status = "closed";
        pos.exitPrice  = priceData.priceUsd;
        pos.exitTime   = new Date().toISOString();
        pos.pnlPct     = pnlPct;
        pos.pnlUsd     = CONFIG.PAPER_TRADE_AMOUNT_USD * (pnlPct / 100);
        pos.exitReason = "STOP_LOSS";
        totalPnL += pos.pnlUsd;
        saveTrades();
        clearInterval(interval);
        await sendTelegram(
          `🛑 <b>STOP LOSS — EXIT ALL NOW</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `<b>${pos.name}</b> (${pos.symbol})\n` +
          `📉 ${pnlPct.toFixed(1)}%\n` +
          `💰 Sell ALL on Axiom now\n` +
          `⚡ Don't hesitate — cut the loss\n\n${links}`
        );
        return;
      }

      // Moon bag — stop tracking after 2 hours post TP2
      if (pos.tp2Hit && elapsed > 2 * 60 * 60 * 1000) {
        pos.status     = "closed";
        pos.exitReason = "MOON_BAG";
        pos.exitTime   = new Date().toISOString();
        pos.pnlPct     = pnlPct;
        pos.pnlUsd     = CONFIG.PAPER_TRADE_AMOUNT_USD * (pnlPct / 100);
        totalPnL += pos.pnlUsd;
        saveTrades();
        clearInterval(interval);
        await sendTelegram(
          `🌙 <b>Moon Bag — Stopped Tracking</b>\n` +
          `<b>${pos.name}</b> (${pos.symbol})\n` +
          `Current: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%\n` +
          `Check manually\n${links}`
        );
      }

    } catch (e) { console.error("Monitor error:", e.message); }
  }, CONFIG.PRICE_CHECK_MS);
}

// ── PROCESS NEW DEX PAID TOKEN ────────────────────────────────────────────────
async function processToken(mintAddress) {
  // Dedup check
  const now = Date.now();
  if (seenTokens.has(mintAddress)) return;
  seenTokens.set(mintAddress, now);

  // Clean old entries
  if (seenTokens.size > 1000) {
    for (const [k, v] of seenTokens.entries()) {
      if (now - v > CONFIG.DEDUP_TTL_MS) seenTokens.delete(k);
    }
  }

  console.log(`\n🔍 DEX Paid detected: ${mintAddress}`);

  // Fetch token details from DexScreener
  const details = await fetchTokenDetails(mintAddress);
  const liquidity = details?.liquidity || 0;

  // Run filters
  const { passed, filters, rug } = await runFilters(mintAddress, liquidity);
  const filterSummary = filters.join("\n");
  const rugUrl   = `https://rugcheck.xyz/tokens/${mintAddress}`;
  const dexUrl   = `https://dexscreener.com/solana/${mintAddress}`;
  const axiomUrl = `https://axiom.trade/t/${mintAddress}`;
  const pumpUrl  = `https://pump.fun/coin/${mintAddress}`;
  const links    = `<a href="${pumpUrl}">Pump.fun</a> | <a href="${axiomUrl}">Axiom</a> | <a href="${dexUrl}">DexScreener</a> | <a href="${rugUrl}">Rugcheck</a>`;

  if (!passed) {
    totalRejected++;
    saveTrades();
    console.log(`🚫 Rejected: ${mintAddress}`);

    // Only alert on Telegram if it passed liquidity (skip tiny coins)
    if (liquidity >= CONFIG.MIN_LIQUIDITY_USD) {
      await sendTelegram(
        `🚫 <b>DEX Paid — REJECTED</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `${details?.name || "Unknown"} (${details?.symbol || "???"})\n` +
        `<code>${mintAddress.slice(0, 20)}...</code>\n\n` +
        `${filterSummary}\n\n${links}`
      );
    }
    return;
  }

  // All filters passed — enter paper trade
  const { trade, entryPrice } = await enterTrade(mintAddress, details);

  const ageStr = details?.age !== null
    ? details.age < 60
      ? `${details.age} min`
      : `${Math.floor(details.age / 60)}h ${details.age % 60}m`
    : "unknown";

  await sendTelegram(
    `💎 <b>DEX PAID — PAPER TRADE ENTERED</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `<b>${details?.name || "Unknown"}</b> (${details?.symbol || "???"})\n` +
    `<code>${mintAddress}</code>\n\n` +
    `💰 Simulated: $${CONFIG.PAPER_TRADE_AMOUNT_USD}\n` +
    `📈 Entry: $${entryPrice > 0 ? entryPrice.toFixed(10) : "fetching..."}\n` +
    `💧 Liquidity: $${liquidity.toLocaleString()}\n` +
    `📊 MCap: $${(details?.marketCap || 0).toLocaleString()}\n` +
    `🕐 Token age: ${ageStr}\n\n` +
    `<b>Filters:</b>\n${filterSummary}\n\n` +
    `🎯 TP1 +${CONFIG.TP1_PCT}% | TP2 +${CONFIG.TP2_PCT}% | 🛑 ${CONFIG.STOP_LOSS_PCT}%\n` +
    `🌙 Moon bag: 20%\n\n` +
    `${links}`
  );
}

// ── WEBSOCKET — REAL-TIME DEX PAID FEED ──────────────────────────────────────
const DEX_WS_URL = "wss://io.dexscreener.com/dex/screener/pairs/h24/1?rankBy[key]=boostScore&rankBy[order]=desc&filters[chainIds][0]=solana";

function startWebSocket() {
  console.log("📡 Connecting to DexScreener WebSocket...");
  const ws = new WebSocket(DEX_WS_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Origin": "https://dexscreener.com",
    }
  });

  let pingInterval;

  ws.on("open", () => {
    console.log("✅ DexScreener WebSocket connected — listening for DEX Paid events");

    // Heartbeat every 30s to keep connection alive
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);
  });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // DexScreener sends pairs array — look for boosted/paid ones
      const pairs = msg?.pairs || msg?.data?.pairs || [];
      if (!Array.isArray(pairs) || pairs.length === 0) return;

      for (const pair of pairs) {
        // Only process Solana pairs with boost/paid status
        if (pair.chainId !== "solana") continue;
        const mintAddress = pair.baseToken?.address;
        if (!mintAddress) continue;

        // boostScore > 0 means DEX Paid
        const boostScore = pair.boostData?.score || pair.boostScore || 0;
        if (boostScore <= 0) continue;

        // Fire instantly
        processToken(mintAddress).catch(e =>
          console.error(`Process error ${mintAddress}:`, e.message)
        );
      }
    } catch (e) {
      // Silently skip malformed messages
    }
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });

  ws.on("close", (code) => {
    console.log(`WebSocket closed (${code}) — reconnecting in 5s...`);
    clearInterval(pingInterval);
    setTimeout(startWebSocket, 5000);
  });

  ws.on("pong", () => {
    // Connection alive
  });
}

// ── MAIN START ────────────────────────────────────────────────────────────────
async function startPolling() {
  connection = new Connection(CONFIG.RPC_URL, "confirmed");

  console.log("🚀 DEX Paid Paper Trading Bot started");
  console.log(`📡 Mode: Real-time WebSocket (fires instantly on DEX Paid)`);
  console.log(`💵 Paper trade amount: $${CONFIG.PAPER_TRADE_AMOUNT_USD}`);
  console.log(`🎯 TP1: +${CONFIG.TP1_PCT}% | TP2: +${CONFIG.TP2_PCT}% | SL: ${CONFIG.STOP_LOSS_PCT}%`);
  console.log(`📲 Telegram: ${CONFIG.TELEGRAM_TOKEN ? "ON" : "OFF"}\n`);

  // Resume open positions
  const open = trades.filter(t => t.status === "open");
  if (open.length > 0) {
    console.log(`▶️  Resuming ${open.length} open positions...`);
    open.forEach(t => monitorTrade(t));
  }

  await sendTelegram(
    `🚀 <b>DEX Paid Paper Bot Started</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📡 Mode: Real-time (instant alerts)\n` +
    `Per trade: $${CONFIG.PAPER_TRADE_AMOUNT_USD}\n` +
    `Min liquidity: $${CONFIG.MIN_LIQUIDITY_USD.toLocaleString()}\n` +
    `TP1: +${CONFIG.TP1_PCT}% | TP2: +${CONFIG.TP2_PCT}%\n` +
    `Stop: ${CONFIG.STOP_LOSS_PCT}% | Moon bag: 20%` +
    (open.length > 0 ? `\n▶️ Resumed ${open.length} open positions` : "")
  );

  scheduleDailySummary();

  // Start real-time WebSocket
  startWebSocket();
}

// ── DAILY SUMMARY ─────────────────────────────────────────────────────────────
function scheduleDailySummary() {
  const next = new Date();
  next.setUTCHours(20, 0, 0, 0);
  if (next <= new Date()) next.setUTCDate(next.getUTCDate() + 1);

  setTimeout(async () => {
    const today  = new Date().toDateString();
    const todays = trades.filter(t =>
      t.status === "closed" && new Date(t.exitTime).toDateString() === today
    );
    const wins = todays.filter(t => t.pnlUsd > 0).length;
    const pnl  = todays.reduce((a, t) => a + (t.pnlUsd || 0), 0);

    await sendTelegram(
      `📊 <b>Daily Summary — DEX Paid Bot</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `Trades: ${todays.length} | ✅ ${wins} | ❌ ${todays.length - wins}\n` +
      `Win rate: ${todays.length ? ((wins / todays.length) * 100).toFixed(0) : 0}%\n` +
      `Today PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}\n` +
      `All-time: ${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)}\n` +
      `Rejected: ${totalRejected}\n\n` +
      `<b>Projected real ($5/trade):</b>\n` +
      `Monthly: ${(pnl * 30) >= 0 ? "+" : ""}$${(pnl * 30).toFixed(2)}`
    );
    scheduleDailySummary();
  }, next - new Date());
}

// ── START ─────────────────────────────────────────────────────────────────────
startPolling();
