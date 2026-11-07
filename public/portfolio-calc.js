// Portfolio maths. Pure functions, no network or page access, so they can be
// tested on their own (see test/portfolio.test.js).
//
// Cost basis uses the average-cost method: a sale removes shares at the
// current average cost, and the difference to the sale price is realised P&L.

export const BASE = "SGD";
export const SCHEMA_VERSION = 1;
const EPS = 1e-9;

export function newPortfolio() {
  return { version: SCHEMA_VERSION, baseCurrency: BASE, transactions: [] };
}

/** Make sure a document loaded from the database has the shape we expect. */
export function normalise(doc) {
  const d = doc && typeof doc === "object" ? doc : {};
  return {
    version: SCHEMA_VERSION,
    baseCurrency: BASE,
    transactions: Array.isArray(d.transactions) ? d.transactions.filter(isValidTx) : [],
  };
}

function isValidTx(t) {
  return t && typeof t.symbol === "string" && (t.type === "buy" || t.type === "sell")
    && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && t.quantity > 0 && t.price >= 0;
}

/** Oldest first; same-day trades keep the order they were entered in. */
export function sortTx(txs) {
  return txs.map((t, i) => [t, i])
    .sort((a, b) => (a[0].date < b[0].date ? -1 : a[0].date > b[0].date ? 1 : a[1] - b[1]))
    .map(([t]) => t);
}

/**
 * Work out current holdings from the list of buys and sells.
 * Returns { holdings: [...], closed: [...] } where each entry is
 * { symbol, name, currency, quantity, cost, avgCost, realised }.
 * Amounts are in the stock's own currency.
 */
export function computeHoldings(transactions) {
  const by = new Map();
  for (const t of sortTx(transactions)) {
    const h = by.get(t.symbol) || { symbol: t.symbol, name: t.name || t.symbol, currency: t.currency || "", quantity: 0, cost: 0, realised: 0 };
    const fees = Number(t.fees) || 0;
    if (t.type === "buy") {
      h.quantity += t.quantity;
      h.cost += t.quantity * t.price + fees;
    } else {
      const qty = Math.min(t.quantity, h.quantity); // never go below zero
      const avg = h.quantity > EPS ? h.cost / h.quantity : 0;
      h.realised += qty * t.price - fees - qty * avg;
      h.cost -= qty * avg;
      h.quantity -= qty;
      if (h.quantity < EPS) { h.quantity = 0; h.cost = 0; }
    }
    if (t.name) h.name = t.name;
    if (t.currency) h.currency = t.currency;
    by.set(t.symbol, h);
  }
  const all = [...by.values()].map((h) => ({ ...h, avgCost: h.quantity > EPS ? h.cost / h.quantity : 0 }));
  return { holdings: all.filter((h) => h.quantity > EPS), closed: all.filter((h) => h.quantity <= EPS) };
}

/** Shares of `symbol` held at the end of `date`, from the given transactions. */
export function heldOn(transactions, symbol, date) {
  const upTo = transactions.filter((t) => t.symbol === symbol && t.date <= date);
  const h = computeHoldings(upTo).holdings.find((x) => x.symbol === symbol);
  return h ? h.quantity : 0;
}

/** Returns an error message, or null if the transaction is fine to add. */
export function validateTx(tx, transactions) {
  if (!tx.symbol) return "Enter a stock code.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tx.date || "")) return "Enter the trade date.";
  if (tx.date > new Date().toISOString().slice(0, 10)) return "The trade date can't be in the future.";
  if (!(tx.quantity > 0)) return "Quantity must be more than zero.";
  if (!(tx.price >= 0)) return "Enter the price per share.";
  if ((tx.fees || 0) < 0) return "Fees can't be negative.";
  if (tx.type === "sell") {
    // Check against holdings on that date AND at every later point, so a
    // back-dated sale can't make a later sale impossible.
    const after = [...transactions, tx];
    const relevant = sortTx(after.filter((t) => t.symbol === tx.symbol));
    let qty = 0;
    for (const t of relevant) {
      qty += t.type === "buy" ? t.quantity : -t.quantity;
      if (qty < -EPS) {
        const had = heldOn(transactions, tx.symbol, tx.date);
        return `You only held ${had} shares of ${tx.symbol} on ${tx.date}.`;
      }
    }
  }
  return null;
}

/**
 * Combine holdings with live prices. quotes[symbol] = { price, prevClose, currency },
 * fx[ccy] = S$ per 1 unit. Returns rows plus totals in S$.
 */
export function valuePortfolio(computed, quotes, fx) {
  const rate = (ccy) => (ccy === BASE ? 1 : fx?.[ccy] ?? null);
  const rows = computed.holdings.map((h) => {
    const q = quotes?.[h.symbol] || {};
    const ccy = q.currency || h.currency;
    const r = rate(ccy);
    const price = q.price ?? null;
    const value = price != null ? price * h.quantity : null;
    const dayChange = price != null && q.prevClose ? (price - q.prevClose) * h.quantity : null;
    const unrealised = value != null ? value - h.cost : null;
    return {
      ...h,
      currency: ccy,
      price,
      prevClose: q.prevClose ?? null,
      dayChangePct: price != null && q.prevClose ? price / q.prevClose - 1 : null,
      value,
      unrealised,
      unrealisedPct: unrealised != null && h.cost > 0 ? unrealised / h.cost : null,
      fx: r,
      valueBase: value != null && r != null ? value * r : null,
      costBase: r != null ? h.cost * r : null,
      dayChangeBase: dayChange != null && r != null ? dayChange * r : null,
      unrealisedBase: unrealised != null && r != null ? unrealised * r : null,
      realisedBase: r != null ? h.realised * r : null,
    };
  });

  const sum = (k) => rows.reduce((a, x) => a + (x[k] ?? 0), 0);
  const totalValue = sum("valueBase");
  for (const x of rows) x.weight = totalValue > 0 && x.valueBase != null ? x.valueBase / totalValue : null;
  rows.sort((a, b) => (b.valueBase ?? -1) - (a.valueBase ?? -1));

  const closedRealised = computed.closed.reduce((a, h) => {
    const r = rate(quotes?.[h.symbol]?.currency || h.currency);
    return a + (r != null ? h.realised * r : 0);
  }, 0);
  const totalCost = sum("costBase");
  const unrealised = sum("unrealisedBase");
  const dayChange = sum("dayChangeBase");
  return {
    rows,
    totals: {
      value: totalValue,
      cost: totalCost,
      unrealised,
      unrealisedPct: totalCost > 0 ? unrealised / totalCost : null,
      dayChange,
      dayChangePct: totalValue - dayChange > 0 ? dayChange / (totalValue - dayChange) : null,
      realised: sum("realisedBase") + closedRealised,
      missingPrices: rows.filter((x) => x.price == null).map((x) => x.symbol),
      missingFx: [...new Set(rows.filter((x) => x.fx == null).map((x) => x.currency))],
    },
  };
}
