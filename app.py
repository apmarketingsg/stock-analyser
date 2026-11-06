"""Stock Analyser: a small Flask app backed by free Yahoo Finance data
(via yfinance) and Google News RSS for headlines around big price moves."""

from __future__ import annotations

import math
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import pandas as pd
import yfinance as yf
from flask import Flask, jsonify, request, send_from_directory

from events import detect_events

app = Flask(__name__, static_folder="static", static_url_path="")

HISTORY_DAYS = 548  # roughly 18 months
CACHE_TTL = 15 * 60
_cache: dict[str, tuple[float, object]] = {}


def cached(key: str, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
    value = fn()
    _cache[key] = (time.time(), value)
    return value


def clean(v):
    """Turn NaN/inf/None into None so the JSON stays valid."""
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    return v


# ---------------------------------------------------------------- search

@app.get("/api/search")
def search():
    q = (request.args.get("q") or "").strip()
    if len(q) < 1:
        return jsonify([])

    def run():
        res = yf.Search(q, max_results=8, news_count=0, lists_count=0,
                        include_research=False, raise_errors=False)
        out = []
        for item in res.quotes or []:
            if item.get("quoteType") not in ("EQUITY", "ETF"):
                continue
            out.append({
                "symbol": item.get("symbol"),
                "name": item.get("longname") or item.get("shortname") or item.get("symbol"),
                "exchange": item.get("exchDisp") or item.get("exchange"),
                "type": item.get("quoteType"),
            })
        return out

    try:
        return jsonify(cached(f"search:{q.lower()}", run))
    except Exception as e:  # network or Yahoo hiccup
        return jsonify({"error": f"Search failed: {e}"}), 502


# ---------------------------------------------------------------- stock

MONEY_SENTENCE = re.compile(
    r"\b(segment|segments|revenue|revenues|sells|sales|offers|provides|generates|"
    r"earns|fees|subscription|licens|advertis|operates through|derives)\b",
    re.I,
)


def how_it_makes_money(summary: str | None) -> list[str]:
    """Pick the sentences in Yahoo's business description that describe
    products, segments or revenue sources. No AI: plain keyword matching."""
    if not summary:
        return []
    sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z])", summary)
    picked = [s.strip() for s in sentences if MONEY_SENTENCE.search(s)]
    return picked[:4]


def next_earnings(t: yf.Ticker, info: dict):
    ts = info.get("earningsTimestamp") or info.get("earningsTimestampStart")
    if ts:
        d = datetime.fromtimestamp(ts, tz=timezone.utc).date()
        if d >= date.today():
            return d.isoformat()
    try:
        cal = t.calendar or {}
        dates = cal.get("Earnings Date") or []
        future = [d for d in dates if d >= date.today()]
        if future:
            return min(future).isoformat()
    except Exception:
        pass
    return None


def build_metrics(t: yf.Ticker, info: dict, price, prev_close):
    """Ordered list of metric cards. Each has a type the front end formats."""
    mcap = info.get("marketCap")
    fcf = info.get("freeCashflow")
    div_rate = info.get("dividendRate")
    if div_rate and price:
        div_yield = div_rate / price
    else:
        div_yield = info.get("trailingAnnualDividendYield")
    change_pct = (price / prev_close - 1) if price and prev_close else None
    dte = info.get("debtToEquity")  # Yahoo reports this as a percentage
    rec = info.get("recommendationKey")
    n_analysts = info.get("numberOfAnalystOpinions")

    m = [
        # Row 1: the basics
        ("Price", price, "money"),
        ("Day change", change_pct, "pct_signed"),
        ("Market cap", mcap, "big_money"),
        ("P/E (TTM)", info.get("trailingPE"), "ratio"),
        ("Forward P/E", info.get("forwardPE"), "ratio"),
        ("EPS (TTM)", info.get("trailingEps") or info.get("epsTrailingTwelveMonths"), "money"),
        ("Dividend yield", div_yield, "pct"),
        ("52-week range", [info.get("fiftyTwoWeekLow"), info.get("fiftyTwoWeekHigh")], "range"),
        ("Beta", info.get("beta"), "ratio"),
        ("Avg volume", info.get("averageVolume"), "big"),
        # Row 2: valuation and profitability
        ("P/B", info.get("priceToBook"), "ratio"),
        ("P/S (TTM)", info.get("priceToSalesTrailing12Months"), "ratio"),
        ("EV/EBITDA", info.get("enterpriseToEbitda"), "ratio"),
        ("PEG", info.get("trailingPegRatio") or info.get("pegRatio"), "ratio"),
        ("Revenue (TTM)", info.get("totalRevenue"), "big_money"),
        ("Revenue growth YoY", info.get("revenueGrowth"), "pct_signed"),
        ("Gross margin", info.get("grossMargins"), "pct"),
        ("Operating margin", info.get("operatingMargins"), "pct"),
        ("Net margin", info.get("profitMargins"), "pct"),
        ("ROE", info.get("returnOnEquity"), "pct"),
        # Row 3: balance sheet and outlook
        ("Debt/Equity", dte / 100 if dte is not None else None, "ratio"),
        ("Current ratio", info.get("currentRatio"), "ratio"),
        ("Free cash flow", fcf, "big_money"),
        ("FCF yield", fcf / mcap if fcf and mcap else None, "pct"),
        ("Payout ratio", info.get("payoutRatio"), "pct"),
        ("Shares outstanding", info.get("sharesOutstanding"), "big"),
        ("Analyst target", info.get("targetMeanPrice"), "money"),
        ("Analyst rating",
         (rec.replace("_", " ").title() + (f" ({n_analysts})" if n_analysts else "")) if rec and rec != "none" else None,
         "text"),
        ("Next earnings", next_earnings(t, info), "date"),
        ("Short interest", info.get("shortPercentOfFloat"), "pct"),
    ]
    return [{"label": l, "value": clean(v) if not isinstance(v, list) else [clean(x) for x in v], "kind": k}
            for l, v, k in m]


@app.get("/api/stock/<symbol>")
def stock(symbol: str):
    symbol = symbol.strip().upper()

    def run():
        t = yf.Ticker(symbol)
        hist = t.history(start=(date.today() - timedelta(days=HISTORY_DAYS)).isoformat(),
                         interval="1d", auto_adjust=False)
        if hist is None or hist.empty:
            return None
        hist = hist.dropna(subset=["Close"])
        try:
            info = t.info or {}
        except Exception:
            info = {}

        closes = hist["Close"]
        price = info.get("currentPrice") or info.get("regularMarketPrice") or float(closes.iloc[-1])
        prev_close = info.get("regularMarketPreviousClose") or info.get("previousClose") \
            or (float(closes.iloc[-2]) if len(closes) > 1 else None)

        series = [{"date": idx.strftime("%Y-%m-%d"), "close": round(float(c), 4)}
                  for idx, c in closes.items()]
        events = detect_events(pd.Series(closes.values, index=[s["date"] for s in series]))

        summary = info.get("longBusinessSummary")
        return {
            "symbol": symbol,
            "name": info.get("longName") or info.get("shortName") or symbol,
            "shortName": info.get("shortName") or info.get("longName") or symbol,
            "exchange": info.get("fullExchangeName") or info.get("exchange"),
            "currency": info.get("currency") or info.get("financialCurrency") or "",
            "sector": info.get("sector"),
            "industry": info.get("industry"),
            "country": info.get("country"),
            "website": info.get("website"),
            "employees": info.get("fullTimeEmployees"),
            "summary": summary,
            "makesMoney": how_it_makes_money(summary),
            "metrics": build_metrics(t, info, price, prev_close),
            "history": series,
            "events": events,
            "historyNote": None if len(series) >= 360 else
                f"Only {len(series)} trading days of data available, showing all of it.",
        }

    try:
        data = cached(f"stock:{symbol}", run)
    except Exception as e:
        return jsonify({"error": f"Could not load {symbol}: {e}"}), 502
    if data is None:
        return jsonify({"error": f"No price data found for {symbol}. Check the code, "
                                 "e.g. D05.SI for DBS on SGX, AAPL for Apple."}), 404
    return jsonify(data)


# ---------------------------------------------------------------- news

def google_news(query: str, start: date, end: date, limit: int = 6):
    q = f"{query} after:{start.isoformat()} before:{end.isoformat()}"
    url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(
        {"q": q, "hl": "en-SG", "gl": "SG", "ceid": "SG:en"})
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (stock-analyser)"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        root = ET.fromstring(resp.read())
    items = []
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        source = (it.findtext("source") or "").strip()
        if source and title.endswith(" - " + source):
            title = title[: -len(source) - 3]
        pub = it.findtext("pubDate")
        try:
            pub_d = parsedate_to_datetime(pub).date().isoformat() if pub else None
        except Exception:
            pub_d = None
        items.append({"title": title, "source": source, "date": pub_d,
                      "link": (it.findtext("link") or "").strip()})
    return items[:limit]


@app.get("/api/news")
def news():
    name = (request.args.get("name") or "").strip()
    symbol = (request.args.get("symbol") or "").strip()
    try:
        d = date.fromisoformat(request.args.get("date", ""))
    except ValueError:
        return jsonify({"error": "bad date"}), 400

    # Clean a company name for searching: "DBS Group Holdings Ltd" -> "DBS Group Holdings"
    query_name = re.sub(r"\b(inc|corp|corporation|ltd|limited|plc|holdings? ltd|co|n\.v|s\.a|ag)\.?$",
                        "", name, flags=re.I).strip(" ,.") or symbol.split(".")[0]
    query = f'"{query_name}"'

    def run():
        # News usually lands the day before or day of a move; look 3 days back, 1 day forward.
        items = google_news(query, d - timedelta(days=3), d + timedelta(days=2))
        if not items:  # widen and loosen if nothing turned up
            items = google_news(query_name + " stock", d - timedelta(days=7), d + timedelta(days=3))
        return items

    try:
        return jsonify({"date": d.isoformat(), "query": query, "items": cached(f"news:{query}:{d}", run)})
    except Exception as e:
        return jsonify({"error": f"News lookup failed: {e}", "items": []}), 502


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
