// Find the significant rises and dips in a price series.
//
// A move counts as significant when it is large compared with the stock's own
// normal volatility, so a 4% day is big for a bank but routine for a small-cap
// tech stock. Two kinds of move are checked:
//
// * single-day moves: daily return at least Z_THRESHOLD times the stock's
//   recent daily standard deviation (and at least MIN_DAY_MOVE in size)
// * five-day moves: catches slower slides or rallies that no single day shows
//
// Nearby moves are merged so one story does not produce a cluster of dots, and
// only the MAX_EVENTS strongest are kept so the chart stays readable.

export const Z_THRESHOLD = 2.5;
export const MIN_DAY_MOVE = 0.02;
export const MIN_WEEK_MOVE = 0.06;
export const WINDOW = 5;
export const VOL_LOOKBACK = 60;
export const MIN_GAP_DAYS = 7; // trading days between two marked events
export const MAX_EVENTS = 12;
const MIN_PERIODS = 15;

function std(xs) {
  const n = xs.length;
  if (n < 2) return NaN;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
}

/**
 * @param {{date: string, close: number}[]} series oldest first
 */
export function detectEvents(series) {
  const pts = series.filter((p) => Number.isFinite(p.close));
  const n = pts.length;
  if (n < 15) return [];
  const c = pts.map((p) => p.close);

  const r1 = c.map((v, i) => (i === 0 ? NaN : v / c[i - 1] - 1));
  const r5 = c.map((v, i) => (i < WINDOW ? NaN : v / c[i - WINDOW] - 1));
  const overall = std(r1.slice(1));

  // Volatility from the days *before* each move, so the move does not mute itself.
  const vol = r1.map((_, i) => {
    const win = r1.slice(Math.max(1, i - VOL_LOOKBACK), i).filter(Number.isFinite);
    const s = win.length >= MIN_PERIODS ? std(win) : overall;
    return s > 0 ? s : overall;
  });

  const candidates = [];
  for (let i = 1; i < n; i++) {
    const z1 = r1[i] / vol[i];
    const z5 = r5[i] / (vol[i] * Math.sqrt(WINDOW));
    if (Math.abs(z1) >= Z_THRESHOLD && Math.abs(r1[i]) >= MIN_DAY_MOVE) {
      candidates.push({ score: Math.abs(z1), i, change: r1[i], days: 1 });
    } else if (Number.isFinite(z5) && Math.abs(z5) >= Z_THRESHOLD && Math.abs(r5[i]) >= MIN_WEEK_MOVE) {
      // Slightly lower priority than a sharp one-day move of the same z
      candidates.push({ score: Math.abs(z5) * 0.9, i, change: r5[i], days: WINDOW });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const cand of candidates) {
    if (chosen.length >= MAX_EVENTS) break;
    if (chosen.every((x) => Math.abs(x.i - cand.i) >= MIN_GAP_DAYS)) chosen.push(cand);
  }
  chosen.sort((a, b) => a.i - b.i);

  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  return chosen.map((x) => ({
    date: pts[x.i].date,
    close: r4(pts[x.i].close),
    change: r4(x.change),
    days: x.days,
    direction: x.change > 0 ? "rise" : "dip",
    score: Math.round(x.score * 100) / 100,
  }));
}
