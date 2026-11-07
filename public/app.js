"use strict";

const $ = (id) => document.getElementById(id);
const state = { data: null, chart: null, newsCache: new Map(), hideTimer: null, cardHovered: false, pinned: null };

// Plain-English explanations shown when hovering a metric card.
const EXPLAIN = {
  "Price": "Latest traded price.",
  "Day change": "Change from the previous close.",
  "Market cap": "Share price times shares outstanding: what the market values the whole company at.",
  "P/E (TTM)": "Price divided by the last 12 months' earnings per share. How many years of current profit you pay for.",
  "Forward P/E": "Price divided by analysts' expected earnings for the next 12 months.",
  "EPS (TTM)": "Net profit per share over the last 12 months.",
  "Dividend yield": "Annual dividend as a percentage of the share price.",
  "52-week range": "Lowest and highest price over the past year.",
  "Beta": "How much the stock moves versus the market. 1 moves with it, above 1 swings more.",
  "Avg volume": "Average number of shares traded per day.",
  "P/B": "Price divided by book value (net assets) per share.",
  "P/S (TTM)": "Market cap divided by the last 12 months' revenue.",
  "EV/EBITDA": "Enterprise value (market cap plus net debt) divided by operating earnings before depreciation.",
  "PEG": "P/E divided by expected earnings growth. Around 1 is often read as fairly priced for its growth.",
  "Revenue (TTM)": "Total sales over the last 12 months.",
  "Revenue growth YoY": "Latest quarter's revenue versus the same quarter last year.",
  "Gross margin": "Revenue left after the direct cost of what was sold.",
  "Operating margin": "Revenue left after running costs, before interest and tax.",
  "Net margin": "Revenue left as final profit.",
  "ROE": "Net profit as a percentage of shareholders' equity.",
  "Debt/Equity": "Total debt divided by shareholders' equity. Banks naturally run high.",
  "Current ratio": "Short-term assets divided by short-term liabilities. Below 1 can mean tight cash.",
  "Free cash flow": "Cash from operations after capital spending, last 12 months.",
  "FCF yield": "Free cash flow as a percentage of market cap.",
  "Payout ratio": "Share of profit paid out as dividends.",
  "Shares outstanding": "Total shares in issue.",
  "Analyst target": "Average 12-month price target from covering analysts.",
  "Analyst rating": "Consensus analyst view (number of analysts in brackets).",
  "Next earnings": "Next scheduled results announcement.",
  "Short interest": "Share of tradable shares sold short. Mostly reported for US stocks.",
};

// ---------------------------------------------------------------- formatting

// Unambiguous prefixes for dollar currencies, so S$ and US$ never look alike.
const CCY_PREFIX = { USD: "US$", SGD: "S$", HKD: "HK$", AUD: "A$", CAD: "C$", NZD: "NZ$", TWD: "NT$" };

function money(v, ccy, compact = false) {
  if (v == null) return null;
  if (CCY_PREFIX[ccy]) {
    const n = new Intl.NumberFormat("en-GB", {
      notation: compact ? "compact" : "standard",
      minimumFractionDigits: compact ? 0 : 2,
      maximumFractionDigits: compact ? 2 : (Math.abs(v) < 1 ? 4 : 2),
    }).format(Math.abs(v));
    return (v < 0 ? "-" : "") + CCY_PREFIX[ccy] + n;
  }
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency", currency: ccy || "USD", currencyDisplay: "narrowSymbol",
      notation: compact ? "compact" : "standard",
      maximumFractionDigits: compact ? 2 : (Math.abs(v) < 1 ? 4 : 2),
    }).format(v);
  } catch {
    return `${ccy} ${num(v, compact)}`;
  }
}
function num(v, compact = false, dp = 2) {
  if (v == null) return null;
  return new Intl.NumberFormat("en-GB", {
    notation: compact ? "compact" : "standard", maximumFractionDigits: dp,
  }).format(v);
}
function pct(v, signed = false) {
  if (v == null) return null;
  const s = (v * 100).toFixed(Math.abs(v) < 0.1 ? 2 : 1) + "%";
  return signed && v > 0 ? "+" + s : s;
}
function niceDate(iso, withDay = true) {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", withDay ? { day: "numeric", month: "short", year: "numeric" } : { month: "short", year: "2-digit" });
}

function formatMetric(m, ccy) {
  const v = m.value;
  switch (m.kind) {
    case "money": return money(v, ccy);
    case "big_money": return money(v, ccy, true);
    case "pct": return pct(v);
    case "pct_signed": return pct(v, true);
    case "ratio": return v == null ? null : num(v, false, 2) + (m.label.includes("Equity") ? "x" : "");
    case "big": return num(v, true);
    case "range": return v && v[0] != null && v[1] != null ? `${money(v[0], ccy)} to ${money(v[1], ccy)}` : null;
    case "date": return niceDate(v);
    default: return v;
  }
}

// ---------------------------------------------------------------- search

let suggestTimer = null, suggestions = [], activeIdx = -1;

$("q").addEventListener("input", () => {
  clearTimeout(suggestTimer);
  const q = $("q").value.trim();
  if (!q) return hideSuggest();
  suggestTimer = setTimeout(() => fetchSuggest(q), 250);
});

$("q").addEventListener("keydown", (e) => {
  if ($("suggest").hidden) return;
  if (e.key === "ArrowDown") { activeIdx = Math.min(activeIdx + 1, suggestions.length - 1); renderSuggest(); e.preventDefault(); }
  if (e.key === "ArrowUp") { activeIdx = Math.max(activeIdx - 1, 0); renderSuggest(); e.preventDefault(); }
  if (e.key === "Escape") hideSuggest();
});

document.addEventListener("click", (e) => { if (!e.target.closest(".search")) hideSuggest(); });

$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) return;
  if (activeIdx >= 0 && suggestions[activeIdx]) return pick(suggestions[activeIdx]);
  hideSuggest();
  // A code-like input (no spaces, short) is tried directly first, otherwise search by name.
  if (/^[A-Za-z0-9.\-^=]{1,12}$/.test(q)) {
    const ok = await load(q.toUpperCase(), true);
    if (ok) return;
  }
  const res = await fetchJSON(`/api/search?q=${encodeURIComponent(q)}`);
  if (Array.isArray(res) && res.length) return pick(res[0]);
  showStatus(`Nothing found for "${q}". Try the exchange code, e.g. D05.SI for DBS.`, true);
});

async function fetchSuggest(q) {
  const res = await fetchJSON(`/api/search?q=${encodeURIComponent(q)}`);
  if ($("q").value.trim() !== q) return;
  suggestions = Array.isArray(res) ? res : [];
  activeIdx = -1;
  renderSuggest();
}
function renderSuggest() {
  const ul = $("suggest");
  if (!suggestions.length) return hideSuggest();
  ul.innerHTML = "";
  suggestions.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = i === activeIdx ? "active" : "";
    li.innerHTML = `<span><span class="sym"></span> <span class="nm"></span></span><span class="ex"></span>`;
    li.querySelector(".sym").textContent = s.symbol;
    li.querySelector(".nm").textContent = s.name;
    li.querySelector(".ex").textContent = s.exchange || "";
    li.addEventListener("click", () => pick(s));
    ul.appendChild(li);
  });
  ul.hidden = false;
}
function hideSuggest() { $("suggest").hidden = true; suggestions = []; activeIdx = -1; }
function pick(s) { hideSuggest(); $("q").value = s.symbol; load(s.symbol); }

async function fetchJSON(url) {
  try {
    const r = await fetch(url);
    const body = await r.json();
    if (!r.ok) return { error: body.error || r.statusText, status: r.status };
    return body;
  } catch (e) {
    return { error: String(e) };
  }
}

function showStatus(msg, isError = false) {
  $("empty").hidden = true;
  $("status").hidden = false;
  $("status").textContent = msg;
  $("status").className = "status" + (isError ? " error" : "");
}

// ---------------------------------------------------------------- load + render

async function load(symbol, quiet404 = false) {
  showTab("analyse");
  showStatus(`Loading ${symbol}...`);
  const data = await fetchJSON(`/api/stock?symbol=${encodeURIComponent(symbol)}`);
  if (data.error) {
    if (quiet404 && data.status === 404) return false;
    showStatus(data.error, true);
    return false;
  }
  $("status").hidden = true;
  state.data = data;
  render(data);
  history.replaceState(null, "", `?s=${encodeURIComponent(data.symbol)}`);
  return true;
}

function render(d) {
  $("result").hidden = false;
  document.title = `${d.symbol} | Stock Analyser`;
  $("name").textContent = d.name;
  $("sub").textContent = [d.symbol, d.exchange, d.currency].filter(Boolean).join(" · ");

  const priceM = d.metrics.find((m) => m.label === "Price");
  const chgM = d.metrics.find((m) => m.label === "Day change");
  $("price").textContent = money(priceM?.value, d.currency) ?? "";
  $("change").textContent = chgM?.value != null ? pct(chgM.value, true) + " today" : "";
  $("change").className = "change " + (chgM?.value > 0 ? "up" : chgM?.value < 0 ? "down" : "");

  // tags
  const tags = [["Sector", d.sector], ["Industry", d.industry], ["Country", d.country],
    ["Employees", d.employees ? num(d.employees, false, 0) : null]];
  $("tags").innerHTML = "";
  for (const [k, v] of tags) {
    if (!v) continue;
    const s = document.createElement("span");
    s.className = "tag";
    s.innerHTML = `${k}: <b></b>`;
    s.querySelector("b").textContent = v;
    $("tags").appendChild(s);
  }
  if (d.website) {
    const a = document.createElement("a");
    a.className = "tag"; a.href = d.website; a.target = "_blank"; a.rel = "noopener";
    a.textContent = d.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
    $("tags").appendChild(a);
  }

  $("summary").textContent = d.summary || "No business description available from Yahoo Finance for this stock.";
  $("summary").classList.add("clamp");
  $("more").hidden = !d.summary || d.summary.length < 380;
  $("more").textContent = "Read more";
  $("money").innerHTML = "";
  const moneyLines = d.makesMoney.length ? d.makesMoney : ["Not stated in the company description."];
  for (const line of moneyLines) {
    const li = document.createElement("li");
    li.textContent = line;
    $("money").appendChild(li);
  }

  // metric cards
  $("cards").innerHTML = "";
  for (const m of d.metrics) {
    const card = document.createElement("div");
    card.className = "card";
    card.title = EXPLAIN[m.label] || "";
    const val = formatMetric(m, d.currency);
    const signed = m.kind === "pct_signed" && m.value != null ? (m.value > 0 ? " up" : m.value < 0 ? " down" : "") : "";
    const small = val && String(val).length > 11 ? " small" : "";
    card.innerHTML = `<div class="label"></div><div class="value${val == null ? " na" : ""}${signed}${small}"></div>`;
    card.querySelector(".label").textContent = m.label;
    card.querySelector(".value").textContent = val ?? "n/a";
    $("cards").appendChild(card);
  }

  const note = [d.summaryNote, d.historyNote].filter(Boolean).join(" ");
  $("history-note").hidden = !note;
  $("history-note").textContent = note;
  renderChart(d);
  renderEventList(d);
}

$("more").addEventListener("click", () => {
  const clamped = $("summary").classList.toggle("clamp");
  $("more").textContent = clamped ? "Read more" : "Show less";
});

// ---------------------------------------------------------------- chart

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function renderChart(d) {
  hideEventCard(true);
  if (state.chart) state.chart.destroy();

  const labels = d.history.map((p) => p.date);
  const closes = d.history.map((p) => p.close);
  const evByDate = new Map(d.events.map((e) => [e.date, e]));
  const evPoints = labels.map((l) => (evByDate.has(l) ? evByDate.get(l).close : null));
  const evColours = labels.map((l) => (evByDate.get(l)?.direction === "rise" ? cssVar("--rise") : cssVar("--dip")));

  const ctx = $("chart").getContext("2d");
  state.chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Close", data: closes, borderColor: cssVar("--line"), backgroundColor: cssVar("--line-fill"),
          fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.15, order: 2,
        },
        {
          label: "Events", data: evPoints, showLine: false, order: 1,
          pointRadius: 7, pointHoverRadius: 10, pointHitRadius: 14, pointBorderWidth: 2,
          pointBackgroundColor: evColours, pointBorderColor: cssVar("--panel"),
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: cssVar("--muted"), maxRotation: 0, autoSkip: true, maxTicksLimit: window.innerWidth < 600 ? 4 : 10,
            callback: (v, i) => niceDate(labels[i], false),
          },
        },
        y: {
          position: "right", grid: { color: cssVar("--border") },
          ticks: { color: cssVar("--muted"), callback: (v) => money(v, d.currency) },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: (item) => item.datasetIndex === 0,
          displayColors: false,
          callbacks: {
            title: (items) => niceDate(labels[items[0].dataIndex]),
            label: (item) => money(item.parsed.y, d.currency),
          },
        },
      },
      onHover: (evt, _active, chart) => {
        const hits = chart.getElementsAtEventForMode(evt, "nearest", { intersect: true }, false)
          .filter((h) => h.datasetIndex === 1);
        if (hits.length) {
          const ev = evByDate.get(labels[hits[0].index]);
          $("chart").style.cursor = "pointer";
          showEventCard(ev, hits[0].element.x, hits[0].element.y);
        } else {
          $("chart").style.cursor = "default";
          if (!state.pinned) scheduleHide();
        }
      },
      onClick: (evt, _a, chart) => {
        const hits = chart.getElementsAtEventForMode(evt, "nearest", { intersect: true }, false)
          .filter((h) => h.datasetIndex === 1);
        if (hits.length) {
          const ev = evByDate.get(labels[hits[0].index]);
          state.pinned = ev.date;
          showEventCard(ev, hits[0].element.x, hits[0].element.y);
        }
      },
    },
  });
}

function renderEventList(d) {
  const box = $("event-list");
  box.innerHTML = "";
  if (!d.events.length) {
    box.innerHTML = `<span class="note">No unusually large moves found in this period.</span>`;
    return;
  }
  for (const ev of d.events) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "event-chip";
    b.innerHTML = `${niceDate(ev.date)} <b class="${ev.change > 0 ? "up" : "down"}">${pct(ev.change, true)}</b>`;
    b.addEventListener("click", () => {
      const idx = d.history.findIndex((p) => p.date === ev.date);
      const el = state.chart.getDatasetMeta(1).data[idx];
      state.pinned = ev.date;
      showEventCard(ev, el.x, el.y);
      $("chart").scrollIntoView({ behavior: "smooth", block: "center" });
    });
    box.appendChild(b);
  }
}

// ---------------------------------------------------------------- event card

const card = $("event-card");
card.addEventListener("mouseenter", () => { state.cardHovered = true; clearTimeout(state.hideTimer); });
card.addEventListener("mouseleave", () => { state.cardHovered = false; if (!state.pinned) scheduleHide(); });
$("chart").addEventListener("mouseleave", () => { if (!state.pinned) scheduleHide(); });

function scheduleHide() {
  clearTimeout(state.hideTimer);
  state.hideTimer = setTimeout(() => { if (!state.cardHovered) hideEventCard(); }, 350);
}
function hideEventCard(force = false) {
  if (force) state.pinned = null;
  card.hidden = true;
  card.dataset.date = "";
}

function positionCard(x, y) {
  const box = $("chart").parentElement.getBoundingClientRect();
  const w = card.offsetWidth, h = card.offsetHeight;
  let left = x + 16;
  if (left + w > box.width - 8) left = x - w - 16;
  left = Math.max(8, left);
  let top = y - h / 2;
  top = Math.max(8, Math.min(top, box.height - h - 8));
  card.style.left = left + "px";
  card.style.top = top + "px";
}

async function showEventCard(ev, x, y) {
  clearTimeout(state.hideTimer);
  if (state.pinned && state.pinned !== ev.date) state.pinned = null; // hovering another dot unpins
  if (card.dataset.date === ev.date && !card.hidden) return;
  card.dataset.date = ev.date;
  const d = state.data;
  const up = ev.change > 0;
  const span = ev.days === 1 ? "in one day" : `over ${ev.days} trading days`;
  card.innerHTML = `
    <button class="close" type="button" aria-label="Close">×</button>
    <div class="ev-head">
      <span class="ev-move ${up ? "up" : "down"}">${up ? "Rise" : "Dip"} ${pct(ev.change, true)}</span>
      <span class="ev-date">${niceDate(ev.date)}, ${span}</span>
    </div>
    <div class="ev-body"><p class="meta">Looking up news around ${niceDate(ev.date)}...</p></div>`;
  card.querySelector(".close").addEventListener("click", () => hideEventCard(true));
  card.hidden = false;
  positionCard(x, y);

  const key = `${d.symbol}:${ev.date}`;
  let news = state.newsCache.get(key);
  if (!news) {
    news = await fetchJSON(`/api/news?symbol=${encodeURIComponent(d.symbol)}&name=${encodeURIComponent(d.shortName || d.name)}&date=${ev.date}`);
    if (!news.error) state.newsCache.set(key, news);
  }
  if (card.dataset.date !== ev.date) return; // user moved on
  const body = card.querySelector(".ev-body");
  if (news.error) {
    body.innerHTML = `<p class="meta"></p>`;
    body.querySelector("p").textContent = news.error;
  } else if (!news.items.length) {
    body.innerHTML = `<p class="meta">No company headlines found for these dates. The move may reflect wider market news, sector moves or results not widely reported.</p>`;
  } else {
    const ul = document.createElement("ul");
    for (const it of news.items) {
      const li = document.createElement("li");
      li.innerHTML = `<a target="_blank" rel="noopener"></a><div class="meta"></div>`;
      li.querySelector("a").href = it.link;
      li.querySelector("a").textContent = it.title;
      li.querySelector(".meta").textContent = [it.source, niceDate(it.date)].filter(Boolean).join(" · ");
      ul.appendChild(li);
    }
    body.innerHTML = "";
    body.appendChild(ul);
  }
  positionCard(x, y);
}

window.addEventListener("resize", () => hideEventCard(true));

// ---------------------------------------------------------------- tabs

function showTab(name) {
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === name);
  $("view-analyse").hidden = name !== "analyse";
  $("view-portfolio").hidden = name !== "portfolio";
  if (name === "portfolio") {
    history.replaceState(null, "", "?tab=portfolio");
    document.title = "Portfolio | Stock Analyser";
    window.dispatchEvent(new Event("portfolio:show"));
  } else if (state.data) {
    history.replaceState(null, "", `?s=${encodeURIComponent(state.data.symbol)}`);
    document.title = `${state.data.symbol} | Stock Analyser`;
  }
  // The chart can't size itself while hidden, so redraw it when it comes back.
  if (name === "analyse" && state.chart) state.chart.resize();
}
for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => showTab(b.dataset.tab));

// "Add to portfolio": hand the stock to the portfolio tab, which fills in its trade form.
$("add-to-pf").addEventListener("click", () => {
  const d = state.data;
  if (!d) return;
  const price = d.metrics.find((m) => m.label === "Price")?.value ?? null;
  window.pendingPrefill = { symbol: d.symbol, name: d.name, currency: d.currency, price };
  showTab("portfolio");
  window.dispatchEvent(new Event("portfolio:prefill"));
});

// Used by the portfolio tab to open a holding in the analyser.
window.stockApp = { analyse: (sym) => { $("q").value = sym; load(sym); } };

// Load from ?s=SYMBOL or ?tab=portfolio so a page can be bookmarked or shared
const params = new URLSearchParams(location.search);
const initial = params.get("s");
if (params.get("tab") === "portfolio") showTab("portfolio");
else if (initial) { $("q").value = initial; load(initial); }
