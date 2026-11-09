// Portfolio and Watchlist tabs: sign-in, loading and saving the user's JSON
// document in Supabase, live valuation, trade entry and the watchlist.
// Formatting helpers (money, pct, num, niceDate) come from app.js, which loads first.

import {
  BASE, newPortfolio, normalise, computeHoldings, valuePortfolio, validateTx, sortTx,
  isWatched, addToWatchlist, removeFromWatchlist, valueWatchlist,
} from "./portfolio-calc.js";

const $ = (id) => document.getElementById(id);
const pf = {
  client: null,
  user: null,
  doc: null,         // { version, baseCurrency, transactions: [...] }
  quotes: {},        // symbol -> { price, prevClose, currency, name }
  fx: { [BASE]: 1 },
  started: false,
  questionDone: false,
  saving: Promise.resolve(),
};

// ---------------------------------------------------------------- views

// Sign-in screens are shared by both tabs; "main" shows each tab's own content.
const ACCOUNT_VIEWS = ["pf-unconfigured", "pf-loading", "pf-auth", "pf-forgot", "pf-question", "pf-password"];
function view(id) {
  for (const v of ACCOUNT_VIEWS) $(v).hidden = v !== id;
  $("pf-main").hidden = id !== "main";
  $("wl-main").hidden = id !== "main";
  $("account-wrap").hidden = !(pf.user && pf.doc);
}

function msg(el, text, kind = "") {
  $(el).hidden = !text;
  $(el).textContent = text || "";
  $(el).className = "msg" + (kind ? " " + kind : "");
}

// ---------------------------------------------------------------- start-up

// Start straight away, not only when a tab opens, so the analyser's Watch
// button knows what is on the watchlist.
window.addEventListener("account:show", start);
start();

async function start() {
  if (pf.started) return;
  pf.started = true;
  view("pf-loading");

  let cfg;
  try { cfg = await (await fetch("/api/config")).json(); } catch { cfg = {}; }
  if (!cfg.configured || !window.supabase) return view("pf-unconfigured");

  pf.client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  pf.client.auth.onAuthStateChange((event, session) => {
    // Defer: Supabase advises against awaiting other calls inside this callback.
    setTimeout(() => onSession(session), 0);
  });
  const { data } = await pf.client.auth.getSession();
  onSession(data.session);
}

async function onSession(session) {
  const user = session?.user || null;
  if (!user) {
    pf.user = null; pf.doc = null; pf.questionDone = false;
    view("pf-auth");
    signInHint();
    notifyWatch();
    return;
  }
  if (pf.user?.id === user.id && pf.doc) return; // already loaded
  pf.user = user;
  view("pf-loading");

  // Everyone needs a secret question, so they can reset a forgotten password.
  if (!pf.questionDone) {
    const st = await security("status");
    if (st.error && st.status !== 503) { msg("auth-msg", st.error, "error"); pf.user = null; return view("pf-auth"); }
    if (st.error) pf.questionDone = true; // reset not configured on the server: don't block the portfolio
    else if (!st.hasQuestion) return showQuestionForm(st.presets, null, false);
    else pf.questionDone = true;
  }
  await loadDoc();
  $("pf-user").textContent = user.email;
  $("account-email").textContent = user.email;
  view("main");
  render();
  applyPrefill();
  await applyPendingWatch();
  notifyWatch();
  refreshPrices();
}

function signInHint() {
  const p = window.pendingPrefill, w = window.pendingWatch;
  if (p) msg("auth-msg", `Sign in to add ${p.symbol} to your portfolio.`);
  else if (w) msg("auth-msg", `Sign in to add ${w.symbol} to your watchlist.`);
}

// ---------------------------------------------------------------- add from analyser

// The analyser's "Add to portfolio" button leaves the stock in window.pendingPrefill.
// Fill the trade form now if the portfolio is open, otherwise once the user signs in.
window.addEventListener("portfolio:prefill", () => {
  if (!$("pf-main").hidden) return applyPrefill();
  if (!$("pf-auth").hidden) signInHint();
});
window.addEventListener("account:show", () => {
  if (window.pendingWatch && pf.doc) applyPendingWatch();
  else if (!$("pf-auth").hidden) signInHint();
});

function applyPrefill() {
  const p = window.pendingPrefill;
  if (!p) return;
  window.pendingPrefill = null;
  $("tx-type").value = "buy";
  $("tx-symbol").value = p.symbol;
  $("tx-date").value = new Date().toISOString().slice(0, 10);
  $("tx-price").value = p.price != null ? String(Math.round(p.price * 1e4) / 1e4) : "";
  $("tx-qty").value = "";
  $("tx-fees").value = "0";
  $("tx-ccy").textContent = p.currency ? `(${p.currency})` : "";
  msg("tx-msg", `${p.symbol} filled in at today's price. Enter the quantity, check the price you paid, then click Add trade.`, "ok");
  $("tx-form").scrollIntoView({ behavior: "smooth", block: "center" });
  $("tx-qty").focus({ preventScroll: true });
}

// ---------------------------------------------------------------- auth

let authAction = "signin";
for (const b of $("auth-form").querySelectorAll("button[type=submit]")) {
  b.addEventListener("click", () => { authAction = b.dataset.action; });
}

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  msg("auth-msg", authAction === "signup" ? "Creating account..." : "Signing in...");
  if (authAction === "signup") {
    const { data, error } = await pf.client.auth.signUp({
      email, password, options: { emailRedirectTo: location.origin + "/?tab=portfolio" },
    });
    if (error) return msg("auth-msg", error.message, "error");
    if (!data.session) {
      return msg("auth-msg", "Account created. Check your email for a confirmation link, then come back and sign in.", "ok");
    }
  } else {
    const { error } = await pf.client.auth.signInWithPassword({ email, password });
    if (error) return msg("auth-msg", error.message, "error");
  }
  msg("auth-msg", "");
});

// ---------------------------------------------------------------- secret question

async function security(action, body = {}) {
  const headers = { "Content-Type": "application/json" };
  if (pf.client) {
    const { data } = await pf.client.auth.getSession();
    if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  try {
    const r = await fetch("/api/security", { method: "POST", headers, body: JSON.stringify({ action, ...body }) });
    const out = await r.json();
    return r.ok ? out : { error: out.error || r.statusText, status: r.status };
  } catch (e) {
    return { error: String(e), status: 0 };
  }
}

const CUSTOM = "__custom__";
let questionMandatory = false;

function showQuestionForm(presets, current, canCancel) {
  questionMandatory = !canCancel;
  const sel = $("question-pick");
  sel.innerHTML = "";
  const list = [...(presets || [])];
  if (current && !list.includes(current)) list.push(current);
  for (const q of list) sel.add(new Option(q, q, false, q === current));
  sel.add(new Option("Write my own question...", CUSTOM));
  $("question-custom-wrap").hidden = true;
  $("question-custom").value = "";
  $("question-answer").value = "";
  $("question-title").textContent = current ? "Change your secret question" : "Set your secret question";
  $("question-cancel").hidden = !canCancel;
  msg("question-msg", "");
  view("pf-question");
}

$("question-pick").addEventListener("change", () => {
  $("question-custom-wrap").hidden = $("question-pick").value !== CUSTOM;
});

$("question-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = $("question-pick").value === CUSTOM ? $("question-custom").value.trim() : $("question-pick").value;
  msg("question-msg", "Saving...");
  const out = await security("set", { question, answer: $("question-answer").value });
  if (out.error) return msg("question-msg", out.error, "error");
  msg("question-msg", "");
  pf.questionDone = true;
  if (questionMandatory) {
    // First-time set-up: carry on into the portfolio.
    const user = pf.user; pf.user = null;
    const { data } = await pf.client.auth.getSession();
    return onSession(data.session || (user ? { user } : null));
  }
  view("main");
  setSaved("Secret question updated");
});

$("question-cancel").addEventListener("click", () => view("main"));

$("pf-change-question").addEventListener("click", async () => {
  const st = await security("status");
  if (st.error) return alert(st.error);
  showQuestionForm(st.presets, st.question, true);
});

// Forgot password: email -> question -> answer + new password.
let forgotEmail = "";

$("forgot").addEventListener("click", () => {
  $("forgot-email").value = $("auth-email").value.trim();
  $("forgot-email-form").hidden = false;
  $("forgot-answer-form").hidden = true;
  msg("forgot-msg", "");
  view("pf-forgot");
});

$("forgot-back").addEventListener("click", () => { msg("auth-msg", ""); view("pf-auth"); });

$("forgot-email-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  forgotEmail = $("forgot-email").value.trim();
  msg("forgot-msg", "Looking up your question...");
  const out = await security("question", { email: forgotEmail });
  if (out.error) return msg("forgot-msg", out.error, "error");
  msg("forgot-msg", "");
  $("forgot-for").textContent = `Account: ${forgotEmail}`;
  $("forgot-question").textContent = out.question;
  $("forgot-answer").value = ""; $("forgot-new").value = ""; $("forgot-new2").value = "";
  $("forgot-email-form").hidden = true;
  $("forgot-answer-form").hidden = false;
  $("forgot-answer").focus();
});

$("forgot-answer-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if ($("forgot-new").value !== $("forgot-new2").value) return msg("forgot-msg", "The two passwords don't match.", "error");
  msg("forgot-msg", "Checking...");
  const out = await security("reset", { email: forgotEmail, answer: $("forgot-answer").value, newPassword: $("forgot-new").value });
  if (out.error) return msg("forgot-msg", out.error, "error");
  $("auth-email").value = forgotEmail;
  $("auth-password").value = "";
  view("pf-auth");
  msg("auth-msg", "Password changed. Sign in with your new password.", "ok");
});

// ---------------------------------------------------------------- account menu

function closeAccountMenu() {
  $("pf-account-menu").hidden = true;
  $("pf-account").setAttribute("aria-expanded", "false");
}
$("pf-account").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = $("pf-account-menu").hidden;
  $("pf-account-menu").hidden = !open;
  $("pf-account").setAttribute("aria-expanded", String(open));
});
$("pf-account-menu").addEventListener("click", closeAccountMenu);
document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) closeAccountMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAccountMenu(); });

// ---------------------------------------------------------------- change password

$("pf-change-password").addEventListener("click", () => {
  $("password-form").reset();
  $("password-username").value = pf.user?.email || "";
  msg("password-msg", "");
  view("pf-password");
  $("password-current").focus();
});
$("password-cancel").addEventListener("click", () => view("main"));

$("password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const current = $("password-current").value;
  const next = $("password-new").value;
  if (next !== $("password-new2").value) return msg("password-msg", "The two new passwords don't match.", "error");
  if (next.length < 8) return msg("password-msg", "The new password must be at least 8 characters.", "error");
  if (next === current) return msg("password-msg", "The new password must be different from the current one.", "error");

  // Confirm the current password by signing in with it again.
  msg("password-msg", "Checking your current password...");
  const check = await pf.client.auth.signInWithPassword({ email: pf.user.email, password: current });
  if (check.error) return msg("password-msg", "Your current password isn't right.", "error");

  msg("password-msg", "Saving...");
  const { error } = await pf.client.auth.updateUser({ password: next });
  if (error) return msg("password-msg", error.message, "error");

  // Anyone signed in elsewhere (perhaps with the old password) is signed out.
  const others = await pf.client.auth.signOut({ scope: "others" });
  view("main");
  setSaved(others.error
    ? "Password changed. Other devices could not be signed out automatically."
    : "Password changed. Other devices have been signed out.");
});

$("pf-signout").addEventListener("click", async () => {
  await pf.saving;
  await pf.client.auth.signOut();
  pf.user = null; pf.doc = null; pf.quotes = {}; pf.questionDone = false;
  view("pf-auth");
  notifyWatch();
});

// ---------------------------------------------------------------- load / save

async function loadDoc() {
  const { data, error } = await pf.client.from("portfolios").select("data, updated_at").eq("user_id", pf.user.id).maybeSingle();
  if (error) {
    pf.doc = newPortfolio();
    setSaved(`Could not load your portfolio: ${error.message}`, true);
    return;
  }
  pf.doc = data ? normalise(data.data) : newPortfolio();
  setSaved(data ? `Last saved ${new Date(data.updated_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}` : "New portfolio");
}

function save() {
  setSaved("Saving...");
  // Chain saves so they reach the database in order.
  pf.saving = pf.saving.then(async () => {
    const { error } = await pf.client.from("portfolios").upsert({ user_id: pf.user.id, data: pf.doc }, { onConflict: "user_id" });
    setSaved(error ? `Not saved: ${error.message}` : "All changes saved", Boolean(error));
  });
  return pf.saving;
}

function setSaved(text, isError = false) {
  pf.savedText = text;
  pf.savedError = isError;
  $("pf-saved").textContent = text;
  $("pf-saved").className = isError ? "down" : "";
  renderWatchSub();
}

// ---------------------------------------------------------------- prices

async function refreshPrices() {
  if (!pf.doc) return;
  const syms = [...new Set([...pf.doc.transactions.map((t) => t.symbol), ...pf.doc.watchlist.map((w) => w.symbol)])];
  if (!syms.length) return render();
  const buttons = [$("pf-refresh"), $("wl-refresh")];
  for (const b of buttons) { b.disabled = true; b.textContent = "Refreshing..."; }
  try {
    const r = await fetch(`/api/quotes?symbols=${encodeURIComponent(syms.join(","))}`);
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.statusText);
    pf.quotes = { ...pf.quotes, ...body.quotes };
    pf.fx = { ...pf.fx, ...body.fx };
    $("pf-warn").hidden = true;
  } catch (e) {
    $("pf-warn").hidden = false;
    $("pf-warn").textContent = `Live prices could not be loaded (${e.message}). Showing cost only.`;
    msg("wl-msg", `Live prices could not be loaded (${e.message}).`, "error");
  } finally {
    for (const b of buttons) { b.disabled = false; b.textContent = "Refresh prices"; }
  }
  render();
}
$("pf-refresh").addEventListener("click", refreshPrices);
$("wl-refresh").addEventListener("click", refreshPrices);

// ---------------------------------------------------------------- render

const sgd = (v) => (v == null ? "n/a" : money(v, BASE));
const signedSgd = (v) => (v == null ? "n/a" : (v > 0 ? "+" : "") + money(v, BASE));
const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");

function render() {
  if (!pf.doc) return;
  const computed = computeHoldings(pf.doc.transactions);
  const { rows, totals } = valuePortfolio(computed, pf.quotes, pf.fx);

  // Summary cards
  const cards = [
    ["Total value", sgd(totals.value), ""],
    ["Today", `${signedSgd(totals.dayChange)}${totals.dayChangePct != null ? ` (${pct(totals.dayChangePct, true)})` : ""}`, cls(totals.dayChange)],
    ["Unrealised gain", `${signedSgd(totals.unrealised)}${totals.unrealisedPct != null ? ` (${pct(totals.unrealisedPct, true)})` : ""}`, cls(totals.unrealised)],
    ["Realised gain", signedSgd(totals.realised), cls(totals.realised)],
    ["Total cost", sgd(totals.cost), ""],
    ["Holdings", String(rows.length), ""],
  ];
  $("pf-totals").innerHTML = "";
  for (const [label, value, c] of cards) {
    const d = document.createElement("div");
    d.className = "card";
    d.innerHTML = `<div class="label"></div><div class="value ${c}${value.length > 14 ? " small" : ""}"></div>`;
    d.querySelector(".label").textContent = label;
    d.querySelector(".value").textContent = value;
    $("pf-totals").appendChild(d);
  }

  const warn = [];
  if (totals.missingPrices.length) warn.push(`No live price for ${totals.missingPrices.join(", ")}.`);
  if (totals.missingFx.length) warn.push(`No exchange rate for ${totals.missingFx.join(", ")}, so those holdings are left out of the S$ totals.`);
  if (warn.length) { $("pf-warn").hidden = false; $("pf-warn").textContent = warn.join(" "); }

  // Holdings table
  const t = $("pf-holdings");
  $("pf-empty").hidden = rows.length > 0;
  t.hidden = rows.length === 0;
  t.innerHTML = `<thead><tr>
    <th>Stock</th><th class="num">Shares</th><th class="num">Avg cost</th><th class="num">Price</th>
    <th class="num">Today</th><th class="num">Value</th><th class="num">Value (S$)</th>
    <th class="num">Unrealised</th><th class="num">Weight</th><th class="num">Watch</th></tr></thead><tbody></tbody>`;
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.className = "clickable";
    tr.title = `Analyse ${r.symbol}`;
    tr.innerHTML = `
      <td><b></b><div class="muted small-text"></div></td>
      <td class="num">${num(r.quantity, false, 4)}</td>
      <td class="num">${money(r.avgCost, r.currency)}</td>
      <td class="num">${r.price != null ? money(r.price, r.currency) : "n/a"}</td>
      <td class="num ${cls(r.dayChangePct)}">${r.dayChangePct != null ? pct(r.dayChangePct, true) : "n/a"}</td>
      <td class="num">${r.value != null ? money(r.value, r.currency) : "n/a"}</td>
      <td class="num">${sgd(r.valueBase)}</td>
      <td class="num ${cls(r.unrealised)}">${r.unrealised != null ? `${(r.unrealised > 0 ? "+" : "") + money(r.unrealised, r.currency)}<div class="small-text">${r.unrealisedPct != null ? pct(r.unrealisedPct, true) : ""}</div>` : "n/a"}</td>
      <td class="num">${r.weight != null ? pct(r.weight) : "n/a"}</td>
      <td class="num"></td>`;
    tr.querySelector("b").textContent = r.symbol;
    tr.querySelector(".muted").textContent = r.name;
    tr.lastElementChild.appendChild(starButton({ symbol: r.symbol, name: r.name, currency: r.currency, price: r.price }));
    tr.addEventListener("click", () => window.stockApp.analyse(r.symbol));
    t.querySelector("tbody").appendChild(tr);
  }

  // Trade history, newest first
  const h = $("pf-tx");
  const txs = sortTx(pf.doc.transactions).reverse();
  h.innerHTML = txs.length
    ? `<thead><tr><th>Date</th><th>Type</th><th>Stock</th><th class="num">Shares</th><th class="num">Price</th><th class="num">Fees</th><th class="num">Total</th><th></th></tr></thead><tbody></tbody>`
    : `<tbody><tr><td class="muted">No trades yet.</td></tr></tbody>`;
  for (const x of txs) {
    const total = x.quantity * x.price + (x.type === "buy" ? 1 : -1) * (x.fees || 0);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${niceDate(x.date)}</td>
      <td><span class="pill ${x.type === "buy" ? "up" : "down"}">${x.type === "buy" ? "Buy" : "Sell"}</span></td>
      <td><b></b></td>
      <td class="num">${num(x.quantity, false, 4)}</td>
      <td class="num">${money(x.price, x.currency)}</td>
      <td class="num">${money(x.fees || 0, x.currency)}</td>
      <td class="num">${money(total, x.currency)}</td>
      <td class="num"><button type="button" class="link danger">Delete</button></td>`;
    tr.querySelector("b").textContent = x.symbol;
    tr.querySelector("button").addEventListener("click", () => deleteTx(x.id));
    h.querySelector("tbody").appendChild(tr);
  }

  renderWatchlist();
}

// ---------------------------------------------------------------- trades

$("tx-date").value = new Date().toISOString().slice(0, 10);
$("tx-date").max = $("tx-date").value;

// Show the currency next to the price box once a known code is typed.
$("tx-symbol").addEventListener("change", async () => {
  const q = await lookup($("tx-symbol").value);
  $("tx-ccy").textContent = q ? `(${q.currency})` : "";
});

async function lookup(raw) {
  const symbol = raw.trim().toUpperCase();
  if (!symbol) return null;
  if (pf.quotes[symbol]) return pf.quotes[symbol];
  try {
    const r = await fetch(`/api/quotes?symbols=${encodeURIComponent(symbol)}`);
    const body = await r.json();
    if (!r.ok) return null;
    Object.assign(pf.quotes, body.quotes);
    Object.assign(pf.fx, body.fx);
    return pf.quotes[symbol] || null;
  } catch {
    return null;
  }
}

$("tx-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const symbol = $("tx-symbol").value.trim().toUpperCase();
  msg("tx-msg", `Checking ${symbol}...`);
  const q = await lookup(symbol);
  if (!q) return msg("tx-msg", `Couldn't find ${symbol}. Use the exchange code, e.g. D05.SI for DBS or AAPL for Apple.`, "error");

  const tx = {
    id: crypto.randomUUID(),
    symbol,
    name: q.name,
    currency: q.currency,
    type: $("tx-type").value,
    date: $("tx-date").value,
    quantity: Number($("tx-qty").value),
    price: Number($("tx-price").value),
    fees: Number($("tx-fees").value) || 0,
  };
  const err = validateTx(tx, pf.doc.transactions);
  if (err) return msg("tx-msg", err, "error");

  pf.doc.transactions.push(tx);
  render();
  await save();
  msg("tx-msg", `Added: ${tx.type} ${tx.quantity} ${symbol} at ${money(tx.price, tx.currency)}.`, "ok");
  $("tx-qty").value = ""; $("tx-price").value = ""; $("tx-fees").value = "0";
});

async function deleteTx(id) {
  const x = pf.doc.transactions.find((t) => t.id === id);
  if (!x) return;
  const rest = pf.doc.transactions.filter((t) => t.id !== id);
  // Removing a buy could leave a later sale selling shares that were never held.
  if (x.type === "buy") {
    for (const s of rest.filter((t) => t.symbol === x.symbol && t.type === "sell")) {
      if (validateTx(s, rest.filter((t) => t.id !== s.id))) {
        return alert(`Can't delete this buy: a later sale of ${x.symbol} depends on it. Delete that sale first.`);
      }
    }
  }
  if (!confirm(`Delete ${x.type} of ${x.quantity} ${x.symbol} on ${niceDate(x.date)}?`)) return;
  pf.doc.transactions = rest;
  render();
  await save();
}

// ---------------------------------------------------------------- export / import

$("pf-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(pf.doc, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `portfolio-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$("pf-import").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let doc;
  try { doc = normalise(JSON.parse(await file.text())); } catch { return alert("That file isn't valid JSON."); }
  for (const t of doc.transactions) if (!t.id) t.id = crypto.randomUUID();
  if (!confirm(`Replace your portfolio and watchlist with ${doc.transactions.length} trades and ${doc.watchlist.length} watched stocks from ${file.name}? Export a backup first if unsure.`)) return;
  pf.doc = doc;
  render();
  notifyWatch();
  await save();
  refreshPrices();
});

// ---------------------------------------------------------------- watchlist

function notifyWatch() { window.dispatchEvent(new Event("watchlist:changed")); }

// Used by the analyser's Watch button (see app.js).
window.watchlistApi = {
  ready: () => Boolean(pf.user && pf.doc),
  has: (symbol) => Boolean(pf.doc && isWatched(pf.doc, symbol)),
  toggle: (stock) => toggleWatch(stock),
};

async function toggleWatch(stock) {
  if (!pf.doc) return;
  if (isWatched(pf.doc, stock.symbol)) removeFromWatchlist(pf.doc, stock.symbol);
  else addToWatchlist(pf.doc, stock);
  render();
  notifyWatch();
  await save();
  if (isWatched(pf.doc, stock.symbol) && !pf.quotes[stock.symbol]) refreshPrices();
}

// A Watch click made while signed out is finished once the watchlist is loaded.
async function applyPendingWatch() {
  const w = window.pendingWatch;
  if (!w || !pf.doc) return;
  window.pendingWatch = null;
  if (addToWatchlist(pf.doc, w)) {
    render();
    notifyWatch();
    await save();
    refreshPrices();
  }
  msg("wl-msg", `${w.symbol} is on your watchlist.`, "ok");
}

function starButton(stock) {
  const b = document.createElement("button");
  b.type = "button";
  const on = isWatched(pf.doc, stock.symbol);
  b.className = "star" + (on ? " on" : "");
  b.innerHTML = on ? "&#9733;" : "&#9734;";
  b.title = on ? `Remove ${stock.symbol} from watchlist` : `Add ${stock.symbol} to watchlist`;
  b.setAttribute("aria-pressed", String(on));
  b.addEventListener("click", (e) => { e.stopPropagation(); toggleWatch(stock); });
  return b;
}

function renderWatchSub() {
  if (!pf.doc) return;
  const n = pf.doc.watchlist.length;
  $("wl-sub").textContent = `${n} stock${n === 1 ? "" : "s"} · ${pf.savedText || ""}`;
  $("wl-sub").className = "sub" + (pf.savedError ? " down" : "");
}

function renderWatchlist() {
  if (!pf.doc) return;
  renderWatchSub();
  const rows = valueWatchlist(pf.doc.watchlist, pf.quotes);
  const t = $("wl-table");
  $("wl-empty").hidden = rows.length > 0;
  t.hidden = rows.length === 0;
  t.innerHTML = `<thead><tr>
    <th>Stock</th><th class="num">Price</th><th class="num">Today</th><th class="num">Since added</th>
    <th>52-week range</th><th class="num">P/E</th><th class="num">Div yield</th>
    <th>Target price</th><th>Note</th><th></th></tr></thead><tbody></tbody>`;
  for (const r of rows) {
    const tr = document.createElement("tr");
    if (r.targetHit) tr.className = "target-hit";
    const ccy = r.currency;
    tr.innerHTML = `
      <td><button type="button" class="link stock-link"><b></b></button><div class="muted small-text name"></div></td>
      <td class="num">${r.price != null ? money(r.price, ccy) : "n/a"}</td>
      <td class="num ${cls(r.dayChangePct)}">${r.dayChangePct != null ? pct(r.dayChangePct, true) : "n/a"}</td>
      <td class="num"><span class="${cls(r.sinceAddedPct)}">${r.sinceAddedPct != null ? pct(r.sinceAddedPct, true) : "n/a"}</span>
        <div class="muted small-text">${r.addedOn ? niceDate(r.addedOn) : ""}${r.addedPrice != null ? ` at ${money(r.addedPrice, ccy)}` : ""}</div></td>
      <td>${rangeCell(r)}</td>
      <td class="num">${r.pe != null ? num(r.pe, false, 1) : "n/a"}</td>
      <td class="num">${r.divYield != null ? pct(r.divYield) : "n/a"}</td>
      <td><input type="number" class="cell-input target-input" min="0" step="any" placeholder="Set"><div class="small-text target-info"></div></td>
      <td><input type="text" class="cell-input note-input" maxlength="200" placeholder="Add a note"></td>
      <td class="num"><button type="button" class="star on" title="Remove from watchlist" aria-label="Remove ${r.symbol} from watchlist">&#9733;</button></td>`;
    tr.querySelector("b").textContent = r.symbol;
    tr.querySelector(".name").textContent = r.name;
    tr.querySelector(".stock-link").addEventListener("click", () => window.stockApp.analyse(r.symbol));

    const target = tr.querySelector(".target-input");
    target.value = r.target ?? "";
    const info = tr.querySelector(".target-info");
    if (r.target != null) {
      if (r.targetHit) info.innerHTML = `<span class="pill hit">Target reached</span>`;
      else if (r.toTargetPct != null) {
        info.className += " muted";
        info.textContent = `${r.targetDir === "up" ? "Rises" : "Falls"} to target: ${pct(Math.abs(r.toTargetPct))} away`;
      }
    }
    target.addEventListener("change", () => updateWatch(r.symbol, { target: Number(target.value) > 0 ? Number(target.value) : null }));

    const note = tr.querySelector(".note-input");
    note.value = r.note || "";
    note.addEventListener("change", () => updateWatch(r.symbol, { note: note.value.trim().slice(0, 200) }, false));

    tr.querySelector(".star").addEventListener("click", () => toggleWatch({ symbol: r.symbol }));
    t.querySelector("tbody").appendChild(tr);
  }
}

function rangeCell(r) {
  if (r.low52 == null || r.high52 == null) return `<span class="muted">n/a</span>`;
  const pos = r.rangePos != null ? Math.round(r.rangePos * 100) : null;
  return `<div class="range" title="${pos != null ? `${pos}% of the way from the 52-week low to the high` : ""}">
      <div class="range-bar">${pos != null ? `<span class="range-dot" style="left:${pos}%"></span>` : ""}</div>
      <div class="range-labels small-text muted"><span>${money(r.low52, r.currency)}</span><span>${money(r.high52, r.currency)}</span></div>
    </div>`;
}

async function updateWatch(symbol, fields, redraw = true) {
  const w = pf.doc.watchlist.find((x) => x.symbol === symbol);
  if (!w) return;
  Object.assign(w, fields);
  if (redraw) renderWatchlist(); // a note change doesn't affect anything shown, so leave the table (and focus) alone
  await save();
}

$("wl-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const symbol = $("wl-add-symbol").value.trim().toUpperCase();
  if (!symbol) return;
  if (isWatched(pf.doc, symbol)) return msg("wl-msg", `${symbol} is already on your watchlist.`);
  msg("wl-msg", `Checking ${symbol}...`);
  const q = await lookup(symbol);
  if (!q) return msg("wl-msg", `Couldn't find ${symbol}. Use the exchange code, e.g. D05.SI for DBS or AAPL for Apple.`, "error");
  addToWatchlist(pf.doc, { symbol, name: q.name, currency: q.currency, price: q.price });
  $("wl-add-symbol").value = "";
  msg("wl-msg", `Added ${symbol}.`, "ok");
  render();
  notifyWatch();
  await save();
});
