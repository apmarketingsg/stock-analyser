# Stock Analyser

Type a stock code or company name. The app shows:

1. **What the company does** and how it makes money (from the Yahoo Finance company description).
2. **30 metric cards** in three rows of up to 10: basics, then valuation and profitability, then balance sheet and outlook. Hover over a card to see what the metric means.
3. **An 18-month price chart** with dots on significant rises (green) and dips (red). Hover over a dot to see the news headlines from around that date.

Data comes from free sources: Yahoo Finance (through the `yfinance` library) and Google News RSS. You don't need any API keys.

## Run it

You need Python 3.10 or newer.

```bash
python3 -m venv .venv
```

```bash
.venv/bin/pip install -r requirements.txt
```

```bash
.venv/bin/python app.py
```

Then open http://127.0.0.1:5000. On Windows, use `.venv\Scripts\python app.py`.

## Codes

- SGX stocks end in `.SI`: DBS is `D05.SI`, Singtel is `Z74.SI`, UOB is `U11.SI`.
- US stocks use the plain ticker: `AAPL`, `MSFT`.
- You can also type a name, such as `DBS` or `Apple`, and pick from the suggestions.

## How a "significant" move is chosen

A move only counts if it is large *for that stock*. A one-day move needs to be at least 2.5 times the stock's normal daily swing over the previous 60 days, and at least 2%. Slower slides or rallies are also caught: a five-day move of 6% or more that is equally unusual. Moves within 7 trading days of each other are merged, and only the 12 strongest are kept. You can tune these in `events.py`.

## Limits worth knowing

- Yahoo's free data is unofficial. It can rate-limit you or change without warning. If a stock fails to load, wait a minute and try again.
- Some metrics are blank for some stocks (shown as n/a). For example, banks have no gross margin, and short interest is mostly reported only for US stocks.
- The headlines are matched to each move by date. They show what was in the news at the time, not a proven cause.
- Prices are in the stock's own currency.
