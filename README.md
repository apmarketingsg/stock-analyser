# Stock Analyser

Type a stock code or company name. The app shows:

1. **What the company does** and how it makes money (from the Yahoo Finance company description).
2. **30 metric cards** in three rows of up to 10: basics, then valuation and profitability, then balance sheet and outlook. Hover over a card to see what the metric means.
3. **An 18-month price chart** with dots on significant rises (green) and dips (red). Hover over a dot to see the news headlines from around that date.
4. **A Portfolio tab** (sign-in required): record buys and sells, and see value, today's change, unrealised and realised gains in S$, and each holding's weight. The **Add to portfolio** button on any analysed stock opens the trade form with that stock and today's price filled in.
5. **A Watchlist tab** (sign-in required): stocks you're watching with price, today's change, change since you added them, 52-week range, P/E, dividend yield, an optional target price (highlighted when reached) and a note. Add stocks with **☆ Watch** on the analysis page, the star on a portfolio holding, or by typing a code.

Data comes from free sources: Yahoo Finance (through the `yahoo-finance2` library) and Google News RSS. You don't need any API keys.

## Deploy on Vercel

1. Import this GitHub repository in Vercel (or redeploy if it's already imported).
2. In **Project Settings, Build and Deployment**, set **Framework Preset** to **Other**. Leave Build Command and Output Directory empty, because `vercel.json` sets them.
3. Deploy. The page is served from `public/`, and the files in `api/` become serverless functions.

## Set up the portfolio database (Supabase)

Each account's portfolio is saved as one JSON document in a Supabase table, one row per user. Supabase handles sign-up and sign-in. Row-level security means each user can only read and change their own row.

Forgotten passwords are reset with a **secret question**: each user sets a question and answer after first signing in, and answers it to choose a new password. No email is needed.

1. **Create a project** at supabase.com. Choose the Singapore region (ap-southeast-1).
2. **Create the table:** open SQL Editor, paste the contents of `supabase/schema.sql`, and click Run.
3. **Set the sign-in links:** go to Authentication, URL Configuration. Set Site URL to your Vercel address (for example `https://your-app.vercel.app`) and add `https://your-app.vercel.app/**` under Redirect URLs. Without this, account confirmation emails link to the wrong place.
4. **Connect Vercel:** in Supabase, go to Project Settings, API Keys, and copy the Project URL and the publishable key. In Vercel, go to Project Settings, Environment Variables, and add:
   - `SUPABASE_URL`: the Project URL
   - `SUPABASE_PUBLISHABLE_KEY`: the publishable key (starts `sb_publishable_`)
   - `SUPABASE_SECRET_KEY`: the secret key (starts `sb_secret_`). This is what lets the server set a new password after a correct secret answer.
5. **Redeploy** in Vercel so the new variables take effect.

### About the keys

- The **publishable key** is designed to be visible in the browser. The page loads it from `/api/config`.
- The **secret key** bypasses all database security, so it must stay on the server. It is only read by `api/security.js`, which runs on Vercel, and is never sent to the browser. Only ever put it in Vercel's Environment Variables, never in the code or GitHub. If it leaks, roll it in Supabase under Project Settings, API Keys.

Supabase's built-in email sender only allows a few emails per hour, which is fine for a handful of users. For more, connect your own email provider under Authentication, Emails, SMTP Settings. Since password resets use the secret question, email is only used to confirm new accounts. You can also turn off "Confirm email" under Authentication, Sign In / Providers, if you don't want new accounts to need a confirmation email.

### What is stored

```json
{
  "version": 1,
  "baseCurrency": "SGD",
  "transactions": [
    { "id": "…", "symbol": "D05.SI", "name": "DBS Group Holdings Ltd", "currency": "SGD",
      "type": "buy", "date": "2025-01-02", "quantity": 100, "price": 40, "fees": 10 }
  ],
  "watchlist": [
    { "symbol": "Z74.SI", "name": "Singapore Telecommunications Ltd", "currency": "SGD",
      "addedOn": "2026-11-09", "addedPrice": 3.2, "target": 3.5, "note": "Wait for results" }
  ]
}
```

Use **Export JSON** on the Portfolio tab to download a backup of both the portfolio and the watchlist, and **Import JSON** to restore one.

### How the secret question works

- **Setting it:** after a user's first sign-in, they must set a question before seeing their portfolio. They can change it later with the **Secret question** button. They can pick from a list or write their own.
- **Storage:** answers are stored only as a salted scrypt hash, in a `security_questions` table that browsers cannot read at all. Capital letters, spaces and punctuation are ignored, so "Mr. Tan" matches "mr tan".
- **Resetting:** the user enters their email, answers the question and picks a new password. The server checks the answer and sets the password.
- **Limits:** five wrong answers lock resets for that account for 15 minutes. An email with no account still gets a question, so the form doesn't reveal who has an account.
- **The trade-off:** a secret question is weaker than an emailed reset link. Anyone who knows or can guess the answer can take over the account. That was judged acceptable for this project.

### Account menu

The **Account** menu (top right, once signed in) has:
- **Change password:** asks for the current password, then the new one twice. After the change, every other device signed in to the account is signed out.
- **Secret question:** change the question or answer used for password resets.
- **Sign out.**

### How the numbers are worked out

- **Average cost:** a sale removes shares at the current average cost, and the difference between that and the sale price (after fees) is the realised gain.
- **S$ conversion:** amounts are converted at today's exchange rate, including cost and realised gains. This shows what your gains are worth in S$ now, not what they were worth on the trade date.

## Run it on your own computer

You need Node.js 20 or newer (nodejs.org).

```bash
npm install
```

```bash
npm start
```

Then open http://localhost:3000. For the Portfolio tab to work locally, set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` as environment variables before `npm start`.

## Project layout

- `public/`: the web page (HTML, CSS, JavaScript, bundled Chart.js)
- `api/`: endpoints for `search`, `stock`, `news`, `quotes` (portfolio prices and exchange rates) and `config` (Supabase settings for the browser)
- `public/portfolio.js`, `public/portfolio-calc.js`: sign-in, the Portfolio and Watchlist tabs, and their maths
- `supabase/schema.sql`: the database tables and their security rules
- `api/security.js`, `lib/security.js`: secret-question set-up and password reset
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
