# Solana Meme Coin Paper Trading Bot — Setup Guide

## What It Does
- Listens to Pump.fun in real-time for new token launches
- Runs every new token through a filter stack (mint revoked, LP locked, top holders, liquidity)
- If filters pass → simulates a $5 paper trade
- Monitors price via DexScreener every 15 seconds
- Sends Telegram alerts for: new token detected, filter result, TP1 hit, trade closed
- Sends daily summary at midnight UAE time
- Logs everything to paper_trades.json

## Step 1 — Get a Free Helius RPC Key
1. Go to https://helius.dev
2. Sign up free (no credit card)
3. Copy your API key
4. Paste into .env as RPC_URL and WS_URL

## Step 2 — Telegram Setup
Already done from your LinkedIn bot:
- Same bot token from @BotFather
- Same chat ID from @userinfobot
- OR create a new bot for this specifically

## Step 3 — Deploy on Railway
1. Push this folder to a new GitHub repo
2. Railway → New Project → Deploy from GitHub
3. Add env vars:
   - RPC_URL
   - WS_URL
   - TELEGRAM_TOKEN
   - TELEGRAM_CHAT_ID
4. Deploy

## What You'll Receive on Telegram

### When a token is REJECTED:
🚫 TOKEN REJECTED
- Which filter failed and why
- Links to Rugcheck + DexScreener

### When a trade is ENTERED (paper):
🟢 PAPER TRADE ENTERED
- Token address
- Simulated $5 entry
- Entry price
- All filter results
- TP/SL levels

### When TP1 hits (+50%):
🟡 PAPER TP1 HIT — partial profit logged

### When trade closes:
🟢/🔴 PAPER TRADE CLOSED
- PnL in $ and %
- Exit reason (TP2/STOP_LOSS/TIME_EXIT)
- Running daily stats + win rate

### Daily summary (midnight UAE):
📊 Full day recap with projected real money P&L

## After 2 Weeks — Go Live Checklist
- [ ] Win rate consistently above 15%?
- [ ] Daily PnL positive over 14 days?
- [ ] Filters catching most rugs?
- [ ] Average winner > 3x average loser?

If YES to all → change PAPER_TRADE_AMOUNT_USD to real SOL amount
and add your wallet private key to .env

## Cost
- Helius RPC: FREE tier (sufficient)
- Railway: FREE tier (sufficient)  
- Rugcheck API: FREE
- DexScreener API: FREE
- Total: $0/month for paper trading
