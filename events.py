"""Find the significant rises and dips in a price series.

A move counts as significant when it is large compared with the stock's own
normal volatility, so a 4% day is big for a bank but routine for a small-cap
tech stock. Two kinds of move are checked:

* single-day moves: daily return at least Z_THRESHOLD times the stock's
  recent daily standard deviation (and at least MIN_DAY_MOVE in size)
* five-day moves: catches slower slides or rallies that no single day shows

Nearby moves are merged so one story does not produce a cluster of dots, and
only the MAX_EVENTS strongest are kept so the chart stays readable.
"""

from __future__ import annotations

import math

import pandas as pd

Z_THRESHOLD = 2.5
MIN_DAY_MOVE = 0.02
MIN_WEEK_MOVE = 0.06
WINDOW = 5
VOL_LOOKBACK = 60
MIN_GAP_DAYS = 7  # trading days between two marked events
MAX_EVENTS = 12


def detect_events(closes: pd.Series) -> list[dict]:
    """closes: Series of closing prices indexed by ISO date strings, oldest first."""
    closes = closes.dropna()
    if len(closes) < 15:
        return []

    r1 = closes.pct_change()
    overall = r1.std()
    # Volatility from the days *before* each move, so the move does not mute itself.
    vol = r1.rolling(VOL_LOOKBACK, min_periods=15).std().shift(1).fillna(overall)
    vol = vol.where(vol > 0, overall)

    r5 = closes.pct_change(WINDOW)
    z1 = r1 / vol
    z5 = r5 / (vol * math.sqrt(WINDOW))

    candidates = []
    positions = {d: i for i, d in enumerate(closes.index)}
    for d in closes.index:
        if abs(z1[d]) >= Z_THRESHOLD and abs(r1[d]) >= MIN_DAY_MOVE:
            candidates.append((abs(z1[d]), d, float(r1[d]), 1))
        elif abs(z5[d]) >= Z_THRESHOLD and abs(r5[d]) >= MIN_WEEK_MOVE:
            # Slightly lower priority than a sharp one-day move of the same z
            candidates.append((abs(z5[d]) * 0.9, d, float(r5[d]), WINDOW))

    candidates.sort(reverse=True)
    chosen: list[tuple] = []
    for c in candidates:
        if len(chosen) >= MAX_EVENTS:
            break
        if all(abs(positions[c[1]] - positions[x[1]]) >= MIN_GAP_DAYS for x in chosen):
            chosen.append(c)

    chosen.sort(key=lambda c: positions[c[1]])
    return [
        {
            "date": d,
            "close": round(float(closes[d]), 4),
            "change": round(change, 4),
            "days": days,
            "direction": "rise" if change > 0 else "dip",
            "score": round(score, 2),
        }
        for score, d, change, days in chosen
    ]
