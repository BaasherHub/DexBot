# 🤖 Crypto Scout Bot

Sends a daily Telegram message at 8:00 AM (Dubai time) with 3–5 deeply researched new crypto projects — real utility, tokenomics, airdrop data, and risk factors.

## How it works

1. Pulls newly listed coins from CoinGecko
2. Pulls trending coins from CoinGecko
3. Scrapes latest headlines from CoinDesk, CoinTelegraph, The Block, Decrypt
4. Feeds everything to Claude AI for deep research + synthesis
5. Sends the report to your Telegram chat every morning

---

## Setup

### 1. Create your Telegram Bot
1. Open Telegram → search `@BotFather`
2. Send `/newbot` → follow prompts → copy the **bot token**
3. Start a chat with your new bot (send it any message)
4. Get your **chat ID**: visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in browser — look for `"chat":{"id": XXXXXXX}`

### 2. Get your Anthropic API Key
Get it from: https://console.anthropic.com/

### 3. (Optional) CoinGecko Pro Key
Free tier works fine. Pro key gives higher rate limits.
Get it from: https://www.coingecko.com/en/api

---

## Deploy on Railway

### Option A: GitHub (recommended)
1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Select your repo
4. Add environment variables (see below)
5. Railway auto-detects the Dockerfile and deploys

### Option B: Railway CLI
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

---

## Environment Variables

Set these in Railway → your service → Variables:

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_TOKEN` | ✅ | Your bot token from BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | Your Telegram chat/user ID |
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic API key |
| `COINGECKO_API_KEY` | ❌ | Optional — CoinGecko Pro key |

---

## Local Testing

```bash
pip install -r requirements.txt

export TELEGRAM_TOKEN="your_token"
export TELEGRAM_CHAT_ID="your_chat_id"
export ANTHROPIC_API_KEY="your_key"

python bot.py
```

The bot runs the scout immediately on startup, then again every day at 08:00 Dubai time.

---

## What the daily message looks like

```
📡 Crypto Scout — Mar 27, 2026

1. **ProjectName (TKR)**
   What it does: ...
   Why now: ...
   Tokenomics: Total 1B | 12% circulating | FDV ~$40M
   Airdrop: Points program live at app.xyz — connect wallet + trade
   Risk: Heavy unlock in 6 months, small team
   Research: https://dexscreener.com/...

2. ...
```
