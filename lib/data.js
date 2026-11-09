// Data layer: Yahoo Finance (via yahoo-finance2) for prices and fundamentals,
// Google News RSS for headlines around big moves. No API keys needed.

import YahooFinance from "yahoo-finance2";
import { detectEvents } from "./events.js";

export const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const NO_VALIDATE = { validateResult: false }; // Yahoo's data drifts; don't fail on schema quirks

const HISTORY_DAYS = 548; // roughly 18 months

// Small in-memory cache. On Vercel it lives only as long as a warm function,
// so the CDN cache headers set in the API routes do most of the work.
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isoDate = (d) => (d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 10) : null);

// ---------------------------------------------------------------- search

export async function search(q) {
  return cached(`search:${q.toLowerCase()}`, 60 * 60e3, async () => {
    const res = await yf.search(q, { quotesCount: 8, newsCount: 0 }, NO_VALIDATE);
    return (res.quotes || [])
      .filter((x) => x.isYahooFinance !== false && ["EQUITY", "ETF"].includes(x.quoteType))
      .map((x) => ({
        symbol: x.symbol,
        name: x.longname || x.shortname || x.symbol,
        exchange: x.exchDisp || x.exchange,
        type: x.quoteType,
      }));
  });
}

// ---------------------------------------------------------------- stock

const MONEY_SENTENCE = /\b(segment|segments|revenue|revenues|sells|sales|offers|provides|generates|earns|fees|subscription|licens|advertis|operates through|derives)/i;

// Pick the sentences in Yahoo's business description that describe products,
// segments or revenue sources. No AI: plain keyword matching.
function howItMakesMoney(summary) {
  if (!summary) return [];
  return summary
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => MONEY_SENTENCE.test(s))
    .slice(0, 4);
}

function nextEarnings(cal) {
  const today = new Date().toISOString().slice(0, 10);
  const dates = (cal?.earnings?.earningsDate || []).map(isoDate).filter((d) => d && d >= today).sort();
  return dates[0] || null;
}

function buildMetrics(m, price, prevClose) {
  const { sd = {}, ks = {}, fd = {}, pr = {}, cal } = m;
  const mcap = fin(pr.marketCap) ?? fin(sd.marketCap);
  const fcf = fin(fd.freeCashflow);
  const divRate = fin(sd.dividendRate);
  const divYield = divRate && price ? divRate / price : fin(sd.dividendYield) ?? fin(sd.trailingAnnualDividendYield);
  const changePct = price && prevClose ? price / prevClose - 1 : fin(pr.regularMarketChangePercent);
  const dte = fin(fd.debtToEquity); // Yahoo reports this as a percentage
  const rec = fd.recommendationKey;
  const nAnalysts = fin(fd.numberOfAnalystOpinions);

  const rows = [
    // Row 1: the basics
    ["Price", price, "money"],
    ["Day change", changePct, "pct_signed"],
    ["Market cap", mcap, "big_money"],
    ["P/E (TTM)", fin(sd.trailingPE), "ratio"],
    ["Forward P/E", fin(sd.forwardPE) ?? fin(ks.forwardPE), "ratio"],
    ["EPS (TTM)", fin(ks.trailingEps), "money"],
    ["Dividend yield", divYield, "pct"],
    ["52-week range", [fin(sd.fiftyTwoWeekLow), fin(sd.fiftyTwoWeekHigh)], "range"],
    ["Beta", fin(sd.beta) ?? fin(ks.beta), "ratio"],
    ["Avg volume", fin(sd.averageVolume), "big"],
    // Row 2: valuation and profitability
    ["P/B", fin(ks.priceToBook), "ratio"],
    ["P/S (TTM)", fin(sd.priceToSalesTrailing12Months), "ratio"],
    ["EV/EBITDA", fin(ks.enterpriseToEbitda), "ratio"],
    ["PEG", fin(ks.pegRatio), "ratio"],
    ["Revenue (TTM)", fin(fd.totalRevenue), "big_money"],
    ["Revenue growth YoY", fin(fd.revenueGrowth), "pct_signed"],
    ["Gross margin", fin(fd.grossMargins) || null, "pct"],
    ["Operating margin", fin(fd.operatingMargins), "pct"],
    ["Net margin", fin(fd.profitMargins) ?? fin(ks.profitMargins), "pct"],
    ["ROE", fin(fd.returnOnEquity), "pct"],
    // Row 3: balance sheet and outlook
    ["Debt/Equity", dte != null ? dte / 100 : null, "ratio"],
    ["Current ratio", fin(fd.currentRatio), "ratio"],
    ["Free cash flow", fcf, "big_money"],
    ["FCF yield", fcf && mcap ? fcf / mcap : null, "pct"],
    ["Payout ratio", fin(sd.payoutRatio), "pct"],
    ["Shares outstanding", fin(ks.sharesOutstanding), "big"],
    ["Analyst target", fin(fd.targetMeanPrice), "money"],
    ["Analyst rating",
      rec && rec !== "none"
        ? rec.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()) + (nAnalysts ? ` (${nAnalysts})` : "")
        : null,
      "text"],
    ["Next earnings", nextEarnings(cal), "date"],
    ["Short interest", fin(ks.shortPercentOfFloat), "pct"],
  ];
  return rows.map(([label, value, kind]) => ({ label, value, kind }));
}

export class NotFound extends Error {}

export async function stock(symbolIn) {
  const symbol = symbolIn.trim().toUpperCase();
  return cached(`stock:${symbol}`, 15 * 60e3, async () => {
    const period1 = new Date(Date.now() - HISTORY_DAYS * 864e5);
    const [chartRes, summaryRes] = await Promise.allSettled([
      yf.chart(symbol, { period1, interval: "1d", return: "array" }, NO_VALIDATE),
      yf.quoteSummary(symbol, {
        modules: ["price", "summaryDetail", "defaultKeyStatistics", "financialData", "assetProfile", "calendarEvents"],
      }, NO_VALIDATE),
    ]);

    if (chartRes.status === "rejected") {
      const msg = String(chartRes.reason?.message || chartRes.reason);
      if (/not found|no data|delisted|404/i.test(msg)) throw new NotFound(symbol);
      throw chartRes.reason;
    }
    const quotes = chartRes.value?.quotes || [];
    const history = quotes
      .filter((q) => q.date && Number.isFinite(q.close))
      .map((q) => ({ date: isoDate(new Date(q.date)), close: Math.round(q.close * 1e4) / 1e4 }));
    if (!history.length) throw new NotFound(symbol);

    const s = summaryRes.status === "fulfilled" ? summaryRes.value || {} : {};
    const pr = s.price || {};
    const sd = s.summaryDetail || {};
    const ks = s.defaultKeyStatistics || {};
    const fd = s.financialData || {};
    const ap = s.assetProfile || {};
    const meta = chartRes.value?.meta || {};

    const price = fin(pr.regularMarketPrice) ?? fin(fd.currentPrice) ?? fin(meta.regularMarketPrice) ?? history.at(-1).close;
    const prevClose = fin(pr.regularMarketPreviousClose) ?? fin(sd.previousClose)
      ?? (history.length > 1 ? history.at(-2).close : null);
    const summary = ap.longBusinessSummary || null;

    return {
      symbol,
      name: pr.longName || pr.shortName || meta.longName || symbol,
      shortName: pr.shortName || pr.longName || meta.shortName || symbol,
      exchange: pr.exchangeName || meta.fullExchangeName || meta.exchangeName || null,
      currency: pr.currency || meta.currency || fd.financialCurrency || "",
      sector: ap.sector || null,
      industry: ap.industry || null,
      country: ap.country || null,
      website: ap.website || null,
      employees: fin(ap.fullTimeEmployees),
      summary,
      makesMoney: howItMakesMoney(summary),
      metrics: buildMetrics({ sd, ks, fd, pr, cal: s.calendarEvents }, price, prevClose),
      history,
      events: detectEvents(history),
      historyNote: history.length >= 360 ? null
        : `Only ${history.length} trading days of data available, showing all of it.`,
      summaryNote: summaryRes.status === "rejected"
        ? "Yahoo did not return company details this time, so some cards are blank. Try again shortly." : null,
    };
  });
}

// ---------------------------------------------------------------- news

const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .trim();
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
};
const addDays = (d, n) => new Date(d.getTime() + n * 864e5).toISOString().slice(0, 10);

async function googleNews(query, start, end, limit = 6) {
  const q = `${query} after:${start} before:${end}`;
  const url = "https://news.google.com/rss/search?" + new URLSearchParams({ q, hl: "en-SG", gl: "SG", ceid: "SG:en" });
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (stock-analyser)" } });
  if (!r.ok) throw new Error(`Google News returned ${r.status}`);
  const xml = await r.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    let title = tag(it, "title");
    const source = tag(it, "source");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    const pub = tag(it, "pubDate");
    items.push({ title, source, date: pub ? isoDate(new Date(pub)) : null, link: tag(it, "link") });
    if (items.length >= limit) break;
  }
  return items;
}

export async function news({ name, symbol, date }) {
  const d = new Date(date + "T00:00:00Z");
  if (isNaN(d)) throw new Error("bad date");
  // "DBS Group Holdings Ltd" -> "DBS Group Holdings"
  const queryName = (name || "")
    .replace(/\b(inc|corp|corporation|ltd|limited|plc|co|n\.v|s\.a|ag)\.?$/i, "")
    .replace(/[ ,.]+$/, "")
    .trim() || (symbol || "").split(".")[0];
  const query = `"${queryName}"`;
  return cached(`news:${query}:${date}`, 24 * 60 * 60e3, async () => {
    // News usually lands the day before or day of a move; look 3 days back, 2 forward.
    let items = await googleNews(query, addDays(d, -3), addDays(d, 2));
    if (!items.length) items = await googleNews(`${queryName} stock`, addDays(d, -7), addDays(d, 3));
    return { date, query, items };
  });
}

// ---------------------------------------------------------------- portfolio quotes

const BASE_CCY = "SGD";

// Prices for several symbols at once, plus the rate to convert each currency
// into S$. fx[ccy] = S$ per 1 unit of ccy.
export async function quotes(symbols) {
  const syms = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 100);
  if (!syms.length) return { quotes: {}, fx: { [BASE_CCY]: 1 }, base: BASE_CCY };
  const key = `quotes:${syms.sort().join(",")}`;
  return cached(key, 5 * 60e3, async () => {
    const rows = await yf.quote(syms, { return: "array" }, NO_VALIDATE);
    const out = {};
    for (const q of [].concat(rows || [])) {
      if (!q?.symbol) continue;
      let price = fin(q.regularMarketPrice);
      let prev = fin(q.regularMarketPreviousClose);
      let low52 = fin(q.fiftyTwoWeekLow);
      let high52 = fin(q.fiftyTwoWeekHigh);
      let ccy = q.currency || q.financialCurrency || "";
      if (ccy === "GBp" || ccy === "GBX") { // London quotes in pence
        const p = (v) => (v != null ? v / 100 : null);
        price = p(price); prev = p(prev); low52 = p(low52); high52 = p(high52);
        ccy = "GBP";
      }
      const divRate = fin(q.trailingAnnualDividendRate) ?? fin(q.dividendRate);
      out[q.symbol.toUpperCase()] = {
        symbol: q.symbol.toUpperCase(),
        name: q.longName || q.shortName || q.symbol,
        currency: ccy.toUpperCase(),
        price,
        prevClose: prev,
        low52,
        high52,
        pe: fin(q.trailingPE),
        // Worked out from the dividend per share so the units are certain.
        divYield: divRate && fin(q.regularMarketPrice) ? divRate / fin(q.regularMarketPrice) : fin(q.trailingAnnualDividendYield),
        exchange: q.fullExchangeName || q.exchange || null,
      };
    }

    const ccys = [...new Set(Object.values(out).map((q) => q.currency).filter((c) => c && c !== BASE_CCY))];
    const fx = { [BASE_CCY]: 1 };
    if (ccys.length) {
      const fxRows = await yf.quote(ccys.map((c) => `${c}${BASE_CCY}=X`), { return: "array" }, NO_VALIDATE);
      for (const r of [].concat(fxRows || [])) {
        const c = r?.symbol?.slice(0, 3);
        const rate = fin(r?.regularMarketPrice);
        if (c && rate) fx[c] = rate;
      }
    }
    return { quotes: out, fx, base: BASE_CCY };
  });
}
