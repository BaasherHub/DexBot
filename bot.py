import os
import asyncio
import logging
import httpx
from datetime import datetime
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
import anthropic

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
TELEGRAM_CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
COINGECKO_API_KEY = os.environ.get("COINGECKO_API_KEY", "")  # optional pro key

HEADERS = {"User-Agent": "CryptoScoutBot/1.0"}


# ── 1. New coins via CoinMarketCap RSS (free, no key) ────────────────────────
async def fetch_new_coingecko_coins() -> list[dict]:
    """
    Pulls recently added coins from two free sources:
    - CoinGecko /coins/list (last N entries are newest)
    - CoinMarketCap new listings RSS
    """
    results = []

    # Source A: CoinGecko full list — tail = most recently added
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(
                "https://api.coingecko.com/api/v3/coins/list",
                headers=HEADERS,
                timeout=20,
            )
            r.raise_for_status()
            all_coins = r.json()
            for c in all_coins[-30:]:
                results.append({"name": c.get("name"), "symbol": c.get("symbol", "").upper()})
    except Exception as e:
        log.warning(f"CoinGecko list error: {e}")

    # Source B: CoinMarketCap new listings RSS
    try:
        import re
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            r = await client.get(
                "https://coinmarketcap.com/new/",
                headers=HEADERS,
            )
            # extract coin names from page title patterns
            titles = re.findall(r'"name":"([^"]{3,40})"', r.text)
            symbols = re.findall(r'"symbol":"([A-Z0-9]{2,10})"', r.text)
            seen = set()
            for name, sym in zip(titles[:20], symbols[:20]):
                key = sym
                if key not in seen:
                    seen.add(key)
                    results.append({"name": name, "symbol": sym})
    except Exception as e:
        log.warning(f"CMC new listings error: {e}")

    log.info(f"Fetched {len(results)} new coin entries")
    return results[:40]


async def fetch_coingecko_trending() -> list[dict]:
    url = "https://api.coingecko.com/api/v3/search/trending"
    headers = HEADERS.copy()
    if COINGECKO_API_KEY:
        headers["x-cg-pro-api-key"] = COINGECKO_API_KEY
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(url, headers=headers)
            r.raise_for_status()
            data = r.json()
            coins = data.get("coins", [])
            return [c["item"] for c in coins[:10]]
    except Exception as e:
        log.warning(f"CoinGecko trending error: {e}")
        return []


# ── 2. Scrape crypto news headlines ──────────────────────────────────────────
async def scrape_crypto_news() -> str:
    sources = [
        ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
        ("CoinTelegraph", "https://cointelegraph.com/rss"),
        ("The Block", "https://www.theblock.co/rss.xml"),
        ("Decrypt", "https://decrypt.co/feed"),
    ]
    headlines = []
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        for name, url in sources:
            try:
                r = await client.get(url, headers=HEADERS)
                text = r.text
                # crude but dependency-free RSS title extraction
                import re
                titles = re.findall(r"<title><!\[CDATA\[(.*?)\]\]></title>", text)
                if not titles:
                    titles = re.findall(r"<title>(.*?)</title>", text)
                # skip first (feed title itself)
                for t in titles[1:6]:
                    headlines.append(f"[{name}] {t.strip()}")
            except Exception as e:
                log.warning(f"RSS {name} error: {e}")
    return "\n".join(headlines) if headlines else "No headlines fetched."


# ── 3. Claude deep research ───────────────────────────────────────────────────
def build_prompt(new_coins: list, trending: list, headlines: str) -> str:
    new_coins_text = "\n".join(
        f"- {c.get('name')} ({c.get('symbol','').upper()})" for c in new_coins
    ) or "None available"

    trending_text = "\n".join(
        f"- {c.get('name')} ({c.get('symbol','').upper()}) — rank #{c.get('market_cap_rank','?')}"
        for c in trending
    ) or "None available"

    return f"""You are a crypto research analyst. Your job is to find 3–5 genuinely promising NEW crypto projects that have recently launched tokens.

Criteria (prioritize all of these):
- Real, useful product already live (not just whitepaper)
- Token recently launched or very early stage (low FDV preferred)
- Innovative sector — DeFi infra, L1/L2, RWA, AI+crypto, privacy, payments, etc.
- Ideally low circulating supply or interesting tokenomics
- Bonus: airdrop campaigns or points programs still active

Here is fresh data to inform your research:

RECENTLY ADDED ON COINGECKO (last 24–48h):
{new_coins_text}

TRENDING ON COINGECKO TODAY:
{trending_text}

LATEST CRYPTO NEWS HEADLINES:
{headlines}

Using this data plus your knowledge, identify 3-5 of the most compelling projects. For each project provide:

1. Name & Ticker
2. What it does (2-3 sentences, plain English)
3. Why it is interesting now (catalyst, recent launch, milestone)
4. Tokenomics snapshot (total supply, circulating %, FDV if known, unlock schedule if notable)
5. Airdrop / Points program (if active, how to participate)
6. Risk factors (be honest, 1-2 lines)
7. Where to research more (DEXScreener or CoinGecko URL as plain text)

CRITICAL FORMATTING - output goes to Telegram as plain text, no Markdown rendering:
- NO asterisks, NO hashtags, NO backticks, NO bracket links
- Use CAPS for labels: WHAT IT DOES / TOKENOMICS / AIRDROP / RISKS / LINKS
- Separate projects with: ------------------------------
- Use emoji for structure: 🔹 project title, 📊 tokenomics, 🪂 airdrop, ⚠️ risks, 🔗 links
- Write URLs as plain text only
- No memecoins, no vaporware. Raw intel for a DYOR trader."""


async def run_claude_research(prompt: str) -> str:
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    try:
        message = client.messages.create(
            model="claude-opus-4-5",
            max_tokens=2000,
            messages=[{"role": "user", "content": prompt}],
        )
        return message.content[0].text
    except Exception as e:
        log.error(f"Claude API error: {e}")
        return f"Claude research failed: {e}"


# ── 4. Send to Telegram ───────────────────────────────────────────────────────
async def send_telegram(text: str):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    # Telegram has 4096 char limit per message — split if needed
    chunks = [text[i : i + 4000] for i in range(0, len(text), 4000)]
    async with httpx.AsyncClient(timeout=20) as client:
        for i, chunk in enumerate(chunks):
            prefix = f"📡 Crypto Scout — {datetime.now().strftime('%b %d, %Y')}\n\n" if i == 0 else ""
            payload = {
                "chat_id": TELEGRAM_CHAT_ID,
                "text": prefix + chunk,
                "disable_web_page_preview": True,
            }
            r = await client.post(url, json=payload)
            if r.status_code != 200:
                log.error(f"Telegram error: {r.text}")
            await asyncio.sleep(0.5)


# ── 5. Main daily job ─────────────────────────────────────────────────────────
async def daily_scout():
    log.info("Starting daily crypto scout...")
    await send_telegram("🔍 Scanning for new projects... report incoming in ~30 seconds.")

    new_coins, trending, headlines = await asyncio.gather(
        fetch_new_coingecko_coins(),
        fetch_coingecko_trending(),
        scrape_crypto_news(),
    )

    log.info(f"Got {len(new_coins)} new coins, {len(trending)} trending, headlines fetched.")

    prompt = build_prompt(new_coins, trending, headlines)
    research = await run_claude_research(prompt)

    footer = (
        "\n\n---\n"
        "⚠️ _This is raw research intel, not financial advice. Always DYOR._\n"
        "📊 _Verify charts: DEXScreener · GeckoTerminal · CoinGecko_"
    )

    await send_telegram(research + footer)
    log.info("Daily scout complete.")


# ── 6. Scheduler ──────────────────────────────────────────────────────────────
async def main():
    scheduler = AsyncIOScheduler(timezone="Asia/Dubai")
    # Every day at 8:00 AM Dubai time
    scheduler.add_job(daily_scout, CronTrigger(hour=8, minute=0))
    scheduler.start()
    log.info("Scheduler started — daily scout at 08:00 Dubai time.")

    # Run immediately on startup so you can test it right away
    await daily_scout()

    # Keep running
    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
