import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHoldings, valuePortfolio, validateTx, normalise } from "../public/portfolio-calc.js";

const tx = (o) => ({ name: o.symbol, currency: "SGD", fees: 0, ...o });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("average cost and realised P&L on a partial sale", () => {
  const { holdings } = computeHoldings([
    tx({ symbol: "D05.SI", type: "buy", date: "2025-01-02", quantity: 100, price: 40, fees: 10 }),
    tx({ symbol: "D05.SI", type: "buy", date: "2025-03-02", quantity: 100, price: 50, fees: 10 }),
    tx({ symbol: "D05.SI", type: "sell", date: "2025-06-02", quantity: 50, price: 60, fees: 5 }),
  ]);
  const h = holdings[0];
  close(h.quantity, 150);
  close(h.avgCost, 45.1);          // (4000 + 10 + 5000 + 10) / 200
  close(h.cost, 150 * 45.1);
  close(h.realised, 50 * 60 - 5 - 50 * 45.1);
});

test("fully sold positions move to closed with their realised P&L", () => {
  const c = computeHoldings([
    tx({ symbol: "Z74.SI", type: "buy", date: "2025-01-02", quantity: 10, price: 3 }),
    tx({ symbol: "Z74.SI", type: "sell", date: "2025-02-02", quantity: 10, price: 4 }),
  ]);
  assert.equal(c.holdings.length, 0);
  close(c.closed[0].realised, 10);
});

test("trades are applied in date order whatever order they were entered", () => {
  const { holdings } = computeHoldings([
    tx({ symbol: "A", type: "sell", date: "2025-05-01", quantity: 5, price: 20 }),
    tx({ symbol: "A", type: "buy", date: "2025-01-01", quantity: 10, price: 10 }),
  ]);
  close(holdings[0].quantity, 5);
  close(holdings[0].realised, 50);
});

test("cannot sell more than held, including back-dated sales", () => {
  const txs = [
    tx({ symbol: "A", type: "buy", date: "2025-01-01", quantity: 10, price: 10 }),
    tx({ symbol: "A", type: "sell", date: "2025-06-01", quantity: 10, price: 12 }),
  ];
  assert.match(validateTx(tx({ symbol: "A", type: "sell", date: "2025-03-01", quantity: 5, price: 11 }), txs), /only held 10/);
  assert.equal(validateTx(tx({ symbol: "A", type: "buy", date: "2025-03-01", quantity: 5, price: 11 }), txs), null);
  assert.match(validateTx(tx({ symbol: "A", type: "sell", date: "2024-12-01", quantity: 1, price: 11 }), []), /only held 0/);
});

test("values convert to S$ and weights add to 100%", () => {
  const c = computeHoldings([
    tx({ symbol: "D05.SI", type: "buy", date: "2025-01-02", quantity: 100, price: 40 }),
    tx({ symbol: "AAPL", currency: "USD", type: "buy", date: "2025-01-02", quantity: 10, price: 200 }),
  ]);
  const v = valuePortfolio(c,
    { "D05.SI": { price: 50, prevClose: 49, currency: "SGD" }, AAPL: { price: 250, prevClose: 255, currency: "USD" } },
    { SGD: 1, USD: 1.3 });
  close(v.totals.value, 5000 + 2500 * 1.3);
  close(v.totals.unrealised, 1000 + 500 * 1.3);
  close(v.totals.dayChange, 100 - 50 * 1.3);
  close(v.rows.reduce((a, r) => a + r.weight, 0), 1);
  assert.deepEqual(v.totals.missingFx, []);
});

test("missing price or exchange rate is reported, not guessed", () => {
  const c = computeHoldings([tx({ symbol: "X", currency: "JPY", type: "buy", date: "2025-01-02", quantity: 1, price: 1 })]);
  const v = valuePortfolio(c, {}, { SGD: 1 });
  assert.deepEqual(v.totals.missingPrices, ["X"]);
  assert.deepEqual(v.totals.missingFx, ["JPY"]);
});

test("normalise drops malformed transactions", () => {
  const d = normalise({ transactions: [{ symbol: "A", type: "buy", date: "2025-01-01", quantity: 1, price: 1 }, { foo: 1 }, null] });
  assert.equal(d.transactions.length, 1);
  assert.deepEqual(normalise(null).transactions, []);
});

import { addToWatchlist, removeFromWatchlist, isWatched, valueWatchlist, newPortfolio, normaliseWatchlist } from "../public/portfolio-calc.js";

test("watchlist add, duplicate, remove", () => {
  const doc = newPortfolio();
  assert.equal(addToWatchlist(doc, { symbol: "d05.si", name: "DBS", currency: "SGD", price: 40 }, "2026-01-02"), true);
  assert.equal(addToWatchlist(doc, { symbol: "D05.SI", price: 41 }), false);
  addToWatchlist(doc, { symbol: "AAPL", currency: "USD", price: 200 }, "2026-01-03");
  assert.deepEqual(doc.watchlist.map((w) => w.symbol), ["AAPL", "D05.SI"]); // newest first
  assert.equal(doc.watchlist[1].addedPrice, 40);
  assert.ok(isWatched(doc, "d05.si"));
  assert.equal(removeFromWatchlist(doc, "D05.SI"), true);
  assert.ok(!isWatched(doc, "D05.SI"));
});

test("watchlist valuation: since added, 52-week position, targets both ways", () => {
  const list = normaliseWatchlist([
    { symbol: "UP", addedPrice: 100, target: 120, addedOn: "2026-01-01" },
    { symbol: "DOWN", addedPrice: 100, target: 90, addedOn: "2026-01-01" },
    { symbol: "NOQ", addedPrice: 10 },
  ]);
  const rows = valueWatchlist(list, {
    UP: { price: 125, prevClose: 120, low52: 80, high52: 130 },
    DOWN: { price: 95, prevClose: 96, low52: 90, high52: 110 },
  });
  const [up, down, noq] = rows;
  close(up.sinceAddedPct, 0.25);
  close(up.rangePos, 45 / 50);
  assert.equal(up.targetDir, "up"); assert.equal(up.targetHit, true);
  assert.equal(down.targetDir, "down"); assert.equal(down.targetHit, false);
  close(down.toTargetPct, 90 / 95 - 1);
  assert.equal(noq.price, null); assert.equal(noq.targetHit, false); assert.equal(noq.rangePos, null);
});

test("watchlist normalise drops junk and duplicates, keeps old documents working", () => {
  const w = normaliseWatchlist([{ symbol: "a" }, { symbol: "A" }, { foo: 1 }, null, { symbol: "B", target: -5, note: 7 }]);
  assert.deepEqual(w.map((x) => x.symbol), ["A", "B"]);
  assert.equal(w[1].target, null); assert.equal(w[1].note, "");
  assert.deepEqual(normalise({ transactions: [] }).watchlist, []); // documents saved before watchlists existed
});
