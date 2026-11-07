// Portfolio tab: sign-in, loading and saving the user's JSON document in
// Supabase, live valuation and trade entry. Formatting helpers (money, pct,
// num, niceDate) come from app.js, which loads first.

import { BASE, newPortfolio, normalise, computeHoldings, valuePortfolio, validateTx, sortTx } from "./portfolio-calc.js";

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

const VIEWS = ["pf-unconfigured", "pf-loading", "pf-auth", "pf-forgot", "pf-question", "pf-main"];
function view(id) { for (const v of VIEWS) $(v).hidden = v !== id; }

function msg(el, text, kind = "") {
  $(el).hidden = !text;
  $(el).textContent = text || "";
  $(el).className = "msg" + (kind ? " " + kind : "");
}

// ---------------------------------------------------------------- start-up

window.addEventListener("portfolio:show", start);
if (!$("view-portfolio").hidden) start();

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
    if (window.pendingPrefill) msg("auth-msg", `Sign in to add ${window.pendingPrefill.symbol} to your portfolio.`);
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
  view("pf-main");
  render();
  applyPrefill();
  refreshPrices();
}

// ---------------------------------------------------------------- add from analyser

// The analyser's "Add to portfolio" button leaves the stock in window.pendingPrefill.
// Fill the trade form now if the portfolio is open, otherwise once the user signs in.
window.addEventListener("portfolio:prefill", () => {
  if (!$("pf-main").hidden) return applyPrefill();
  const p = window.pendingPrefill;
  if (p && !$("pf-auth").hidden) msg("auth-msg", `Sign in to add ${p.symbol} to your portfolio.`);
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
  view("pf-main");
  setSaved("Secret question updated");
});

$("question-cancel").addEventListener("click", () => view("pf-main"));

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

$("pf-signout").addEventListener("click", async () => {
  await pf.saving;
  await pf.client.auth.signOut();
  pf.user = null; pf.doc = null; pf.quotes = {}; pf.questionDone = false;
  view("pf-auth");
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
  $("pf-saved").textContent = text;
  $("pf-saved").className = isError ? "down" : "";
}

// ---------------------------------------------------------------- prices

async function refreshPrices() {
  const syms = [...new Set(pf.doc.transactions.map((t) => t.symbol))];
  if (!syms.length) return render();
  $("pf-refresh").disabled = true;
  $("pf-refresh").textContent = "Refreshing...";
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
  } finally {
    $("pf-refresh").disabled = false;
    $("pf-refresh").textContent = "Refresh prices";
  }
  render();
}
$("pf-refresh").addEventListener("click", refreshPrices);

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
    <th class="num">Unrealised</th><th class="num">Weight</th></tr></thead><tbody></tbody>`;
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
      <td class="num">${r.weight != null ? pct(r.weight) : "n/a"}</td>`;
    tr.querySelector("b").textContent = r.symbol;
    tr.querySelector(".muted").textContent = r.name;
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
  if (!confirm(`Replace your portfolio with ${doc.transactions.length} trades from ${file.name}? Export a backup first if unsure.`)) return;
  pf.doc = doc;
  render();
  await save();
  refreshPrices();
});
