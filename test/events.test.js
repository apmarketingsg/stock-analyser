import { test } from "node:test";
import assert from "node:assert/strict";
import { detectEvents } from "../lib/events.js";

// Deterministic pseudo-random walk with a few planted moves.
function series(n, planted) {
  let seed = 7, price = 30;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.02;
  const out = [];
  const start = Date.UTC(2025, 4, 1);
  for (let i = 0; i < n; i++) {
    price *= 1 + (planted[i] ?? rand());
    out.push({ date: new Date(start + i * 864e5).toISOString().slice(0, 10), close: price });
  }
  return out;
}

test("finds planted big moves with the right direction", () => {
  const s = series(380, { 80: 0.08, 200: -0.09 });
  const ev = detectEvents(s);
  const rise = ev.find((e) => e.date === s[80].date);
  const dip = ev.find((e) => e.date === s[200].date);
  assert.ok(rise && rise.direction === "rise" && rise.days === 1);
  assert.ok(dip && dip.direction === "dip");
  assert.ok(ev.length <= 12);
});

test("catches a slow five-day slide", () => {
  const planted = {};
  for (let i = 260; i < 265; i++) planted[i] = -0.03;
  const ev = detectEvents(series(380, planted));
  assert.ok(ev.some((e) => e.direction === "dip" && e.date >= "2026-01-16" && e.date <= "2026-01-22"), JSON.stringify(ev));
});

test("keeps marked events at least 7 trading days apart", () => {
  const ev = detectEvents(series(380, { 100: 0.07, 102: 0.07, 104: -0.07 }));
  const idx = ev.map((e) => (Date.parse(e.date) - Date.UTC(2025, 4, 1)) / 864e5);
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] - idx[i - 1] >= 7);
});

test("short or flat history returns no events", () => {
  assert.deepEqual(detectEvents(series(10, {})), []);
});
