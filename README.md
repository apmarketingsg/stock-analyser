# Stock Analyser

Type a stock code or company name. The app shows:

1. **What the company does** and how it makes money (from the Yahoo Finance company description).
2. **30 metric cards** in three rows of up to 10: basics, then valuation and profitability, then balance sheet and outlook. Hover over a card to see what the metric means.
3. **An 18-month price chart** with dots on significant rises (green) and dips (red). Hover over a dot to see the news headlines from around that date.

Data comes from free sources: Yahoo Finance (through the `yahoo-finance2` library) and Google News RSS. You don't need any API keys.

## Deploy on Vercel

1. Import this GitHub repository in Vercel (or redeploy if it's already imported).
2. In **Project Settings, Build and Deployment**, set **Framework Preset** to **Other**. Leave Build Command and Output Directory empty, because `vercel.json` sets them.
3. Deploy. The page is served from `public/`, and the files in `api/` become serverless functions.

## Run it on your own computer

You need Node.js 20 or newer (nodejs.org).

```bash
npm install
```

```bash
npm start
```

Then open http://localhost:3000.

## Project layout

- `public/`: the web page (HTML, CSS, JavaScript, bundled Chart.js)
- `api/`: three endpoints: `search`, `stock` and `news`
- `lib/data.js`: fetches from Yahoo Finance and Google News
- `lib/events.js`: decides which price moves get a dot
- `server.js`: local server only; Vercel doesn't use it

## Codes

- SGX stocks end in `.SI`: DBS is `D05.SI`, Singtel is `Z74.SI`, UOB is `U11.SI`.
- US stocks use the plain ticker: `AAPL`, `MSFT`.
- You can also type a name, such as `DBS` or `Apple`, and pick from the suggestions.

## How a "significant" move is chosen

A move only counts if it is large *for that stock*. A one-day move needs to be at least 2.5 times the stock's normal daily swing over the previous 60 days, and at least 2%. Slower slides or rallies are also caught: a five-day move of 6% or more that is equally unusual. Moves within 7 trading days of each other are merged, and only the 12 strongest are kept. You can tune these at the top of `lib/events.js`.

## Limits worth knowing

- Yahoo's free data is unofficial. It sometimes limits or blocks requests from cloud servers, including Vercel's. If a stock fails to load, wait a minute and try again.
- Some metrics are blank for some stocks (shown as n/a). For example, banks have no gross margin, and short interest is mostly reported only for US stocks.
- The headlines are matched to each move by date. They show what was in the news at the time, not a proven cause.
- Prices are in the stock's own currency.
