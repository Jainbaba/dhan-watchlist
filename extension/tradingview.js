// Runs in the MAIN world on TradingView chart pages and answers the same
// __dhanWL requests main.js answers on tv.dhan.co, so bridge.js, the worker and
// the panel need no second protocol. The chart is window.TradingViewApi, quotes
// come from the page's own quote session, and symbol search is TradingView's
// public symbol-search endpoint - nothing here needs a TradingView login.
//
// Symbols: the panel's lists hold Dhan's "NSEE<id>:<NAME>" or "NSE:TICKER".
// Dhan's NAME is often the company name ("NSEE7229:HCL TECHNOLOGIES"), not a
// ticker, so a Dhan symbol is resolved to TradingView's "NSE:TICKER" once per
// page (tvSymbols), and every reply is keyed by the symbol exactly as the
// panel sent it.

(() => {
  "use strict";

  const SYMBOL_RE = /^(?:NSEE\d+|NSE):[A-Z0-9_.&()' -]{1,60}$/;
  const SEARCH_URL = "https://symbol-search.tradingview.com/symbol_search/v3/";
  const LIST_URLS = {
    published: "https://raw.githubusercontent.com/Jainbaba/dhan-watchlist/main/watchlist.json",
    ath: "https://raw.githubusercontent.com/Jainbaba/dhan-watchlist/main/ath-watchlist.json",
  };
  const SCREENER_TIMEOUT_MS = 20000;
  const QUOTE_MAX = 1000;
  // A symbol the session has not answered for by then is reported missing.
  const QUOTE_WAIT_MS = 6000;
  // The worker's screener query filter; anything else is dropped from a name.
  const QUERY_CHARS = /[^A-Za-z0-9 &.'()-]/g;

  const post = (payload) => window.postMessage(payload, window.location.origin);
  const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  // panel symbol -> "NSE:TICKER" (or null once it failed to resolve).
  const tvCache = new Map();
  // A chart showing a stock the panel holds in Dhan's spelling is reported
  // under that spelling, so the highlight and flags find its row.
  const tvKey = (s) => String(s).replace(/[&-]/g, "_");
  function panelSymbolFor(tv) {
    for (const [panel, mapped] of tvCache) if (mapped && tvKey(mapped) === tvKey(tv) && panel !== tv) return panel;
    return tv;
  }
  const chart = () => {
    const api = window.TradingViewApi;
    const active = api && typeof api.activeChart === "function" && api.activeChart();
    if (!active || typeof active.setSymbol !== "function") throw new Error("TradingView chart is not ready");
    return active;
  };
  // symbol() reads "NSE_DLY:RELIANCE" on a delayed feed; symbolExt() carries
  // the plain exchange and ticker either way.
  function charted() {
    const ext = chart().symbolExt() || {};
    const exchange = String(ext.exchange || "").toUpperCase();
    const ticker = String(ext.symbol || "").toUpperCase();
    if (!ticker) throw new Error("TradingView chart is not ready");
    return {
      exchange,
      ticker,
      symbol: exchange === "NSE" ? `NSE:${ticker}` : String(ext.pro_name || `${exchange}:${ticker}`),
      name: String(ext.description || ticker).trim(),
    };
  }
  // Screener's search takes a ticker but not TradingView's "_" spelling (M_M,
  // BAJAJ_AUTO); the company name finds those, once "Limited"/"Ltd." is off.
  function screenerQuery({ ticker, name }) {
    if (/^[A-Z0-9&.'()-]+$/.test(ticker)) return ticker;
    return name.replace(/\s+(limited|ltd\.?)$/i, "").replace(QUERY_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  }

  // ---------- quotes ----------

  function session() {
    if (typeof window.getQuoteSessionInstance !== "function") throw new Error("This TradingView page exposes no quote session, so Last/Chg stay empty.");
    return window.getQuoteSessionInstance("simple");
  }
  const quoteOf = (symbol, values) => ({
    symbol,
    last: finite(values.last_price),
    change: finite(values.change),
    changePercent: finite(values.change_percent),
  });

  // One-shot: subscribe, keep each symbol's first full answer, unsubscribe.
  // Resolves with Map(tvSymbol -> {status, values}).
  let probeSeq = 0;
  function probe(tvSymbols) {
    const quotes = session();
    const id = `tradebaba-probe-${++probeSeq}`;
    const answers = new Map(), complete = new Set();
    return new Promise((resolve) => {
      let timer = null, settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); quotes.unsubscribe(id, tvSymbols, onData); resolve(answers); };
      // Fields arrive in pieces; the session merges them into values, so keep
      // the latest and call a symbol done once it is an error or has a price.
      function onData(data) {
        if (!data || !data.symbolname) return;
        const values = data.values || {};
        answers.set(data.symbolname, { status: data.status, values });
        if (data.status !== "ok" || values.last_price !== undefined) complete.add(data.symbolname);
        if (complete.size >= tvSymbols.length) setTimeout(finish, 0);
      }
      timer = setTimeout(finish, QUOTE_WAIT_MS);
      quotes.subscribe(id, tvSymbols, onData);
    });
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.__dhanWL !== "get-quotes") return;
    const reply = (payload) => post({ __dhanWL: "get-quotes-result", id: msg.id, ...payload });
    const symbols = (Array.isArray(msg.symbols) ? msg.symbols : []).map(String).filter((s) => SYMBOL_RE.test(s)).slice(0, QUOTE_MAX);
    if (!symbols.length) return reply({ quotes: [] });
    (async () => {
      const resolved = await tvSymbols(symbols);
      const answers = await probe([...new Set([...resolved.values()].filter(Boolean))]);
      reply({
        quotes: symbols
          .map((symbol) => [symbol, answers.get(resolved.get(symbol))])
          .filter(([, a]) => a && a.status === "ok")
          .map(([symbol, a]) => quoteOf(symbol, a.values)),
      });
    })().catch((err) => reply({ error: err.message }));
  });

  // Live ticks: one standing subscription, replaced whenever the panel's row
  // set changes, flushed once a second like main.js does on Dhan.
  const WATCH_ID = "tradebaba-watch";
  let watched = [], watchedBy = new Map(), tickBuffer = new Map(), tickTimer = null;
  function onTick(data) {
    if (!data || data.status !== "ok" || !data.values) return;
    (watchedBy.get(data.symbolname) || []).forEach((symbol) => tickBuffer.set(symbol, quoteOf(symbol, data.values)));
  }
  function flushTicks() {
    if (!tickBuffer.size) return;
    const quotes = [...tickBuffer.values()];
    tickBuffer = new Map();
    post({ __dhanWL: "quote-tick", quotes });
  }
  let watchSeq = 0;
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.__dhanWL !== "watch-quotes") return;
    const reply = (payload) => post({ __dhanWL: "watch-quotes-result", id: msg.id, ...payload });
    const seq = ++watchSeq;
    (async () => {
      const quotes = session();
      const symbols = (Array.isArray(msg.symbols) ? msg.symbols : []).map(String).filter((s) => SYMBOL_RE.test(s)).slice(0, QUOTE_MAX);
      const resolved = await tvSymbols(symbols);
      // A newer request replaced this one while it was resolving.
      if (seq !== watchSeq) return reply({ streaming: true });
      if (watched.length) quotes.unsubscribe(WATCH_ID, watched, onTick);
      clearInterval(tickTimer);
      tickTimer = null;
      watchedBy = new Map();
      resolved.forEach((key, symbol) => { if (key) watchedBy.set(key, [...(watchedBy.get(key) || []), symbol]); });
      watched = [...watchedBy.keys()];
      if (!watched.length) return reply({ streaming: false });
      quotes.subscribe(WATCH_ID, watched, onTick);
      tickTimer = setInterval(flushTicks, 1000);
      reply({ streaming: true });
    })().catch((err) => reply({ streaming: false, error: err.message }));
  });

  // ---------- search and bulk resolve ----------

  const stripTags = (s) => String(s || "").replace(/<[^>]*>/g, "").trim();
  async function search(text) {
    const url = `${SEARCH_URL}?text=${encodeURIComponent(text)}&hl=0&exchange=NSE&lang=en&search_type=stocks&domain=production`;
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) throw new Error(`TradingView search failed: http ${res.status}`);
    const body = await res.json();
    const seen = new Set();
    return (Array.isArray(body && body.symbols) ? body.symbols : [])
      .filter((row) => row && row.exchange === "NSE" && row.type === "stock")
      .map((row) => ({ symbol: `NSE:${stripTags(row.symbol).toUpperCase()}`, name: stripTags(row.description) }))
      .filter((hit) => SYMBOL_RE.test(hit.symbol) && !seen.has(hit.symbol) && seen.add(hit.symbol));
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.__dhanWL !== "search-symbols") return;
    const reply = (payload) => post({ __dhanWL: "search-symbols-result", id: msg.id, ...payload });
    const query = String(msg.query || "").trim();
    if (!query) return reply({ hits: [] });
    search(query).then((hits) => reply({ hits: hits.slice(0, 20) }), (err) => reply({ error: err.message }));
  });

  async function fetchList(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`list fetch failed: http ${res.status} for ${url}`);
    const list = await res.json();
    if (!Array.isArray(list.symbols) || !list.symbols.length) throw new Error(`published list has no symbols: ${url}`);
    return list;
  }

  // A ticker is checked against the quote session, which answers hundreds at
  // once; a name the session does not know (a company name, a typo) gets one
  // search, and only an exact ticker or a sole result counts - never a guess.
  // Map(name -> hit, or null when nothing matched). A name whose search
  // failed is left out, so a network blip is not remembered as "no such stock".
  async function resolveEach(names) {
    const tickers = names.map((n) => n.toUpperCase().replace(/-/g, "_"));
    const candidates = [...new Set(tickers.map((t) => `NSE:${t}`).filter((s) => SYMBOL_RE.test(s) && !s.includes(" ")))];
    const answers = new Map();
    for (let i = 0; i < candidates.length; i += 200) {
      (await probe(candidates.slice(i, i + 200))).forEach((v, k) => answers.set(k, v));
    }
    const out = new Map(), unresolved = [];
    names.forEach((name, i) => {
      const answer = answers.get(`NSE:${tickers[i]}`);
      if (answer && answer.status === "ok") {
        out.set(name, { symbol: `NSE:${String(answer.values.short_name || tickers[i]).toUpperCase()}`, name: String(answer.values.description || name).trim() });
      } else unresolved.push(name);
    });
    for (let i = 0; i < unresolved.length; i += 4) {
      await Promise.all(unresolved.slice(i, i + 4).map(async (name) => {
        let rows;
        try { rows = await search(name); } catch (_) { return; }
        const ticker = name.toUpperCase().replace(/-/g, "_");
        // An exact ticker wins; otherwise a company name counts only when it is
        // the sole result or the top-ranked result's name starts with it
        // ("Infosys" -> INFY).
        const hit = rows.find((r) => r.symbol.split(":")[1] === ticker)
          || (rows.length === 1 || (rows[0] && rows[0].name.toLowerCase().startsWith(name.toLowerCase())) ? rows[0] : null);
        out.set(name, hit && SYMBOL_RE.test(hit.symbol) ? hit : null);
      }));
    }
    return out;
  }

  async function resolveNames(names) {
    const each = await resolveEach(names);
    const hits = [], missing = [], seen = new Set();
    names.forEach((name) => {
      const hit = each.get(name);
      if (!hit) missing.push(name);
      else if (!seen.has(hit.symbol)) { seen.add(hit.symbol); hits.push(hit); }
    });
    return { hits, missing };
  }

  // Panel symbol -> TradingView symbol. "NSE:" passes through; a Dhan symbol
  // is resolved by its NAME and remembered for the page.
  async function tvSymbols(symbols) {
    const pending = [...new Set(symbols.filter((s) => !s.startsWith("NSE:") && !tvCache.has(s)))];
    if (pending.length) {
      const names = pending.map((s) => s.split(":").at(-1).trim());
      const each = await resolveEach([...new Set(names)]);
      pending.forEach((s, i) => { if (each.has(names[i])) tvCache.set(s, each.get(names[i])?.symbol || null); });
    }
    return new Map(symbols.map((s) => [s, s.startsWith("NSE:") ? s.replace(/[&-]/g, "_") : tvCache.get(s) || null]));
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.__dhanWL !== "bulk-resolve") return;
    const reply = (payload) => post({ __dhanWL: "bulk-resolve-result", id: msg.id, ...payload });
    (async () => {
      const names = msg.source
        ? (await fetchList(LIST_URLS[msg.source] || LIST_URLS.published)).symbols.map((n) => String(n).split(":").at(-1).trim()).filter(Boolean)
        : (Array.isArray(msg.names) ? msg.names : []).map((n) => String(n).trim()).filter(Boolean).slice(0, 200);
      if (!names.length) return reply({ hits: [], missing: [], requested: 0 });
      const { hits, missing } = await resolveNames(names);
      reply({ hits, missing, requested: names.length });
    })().catch((err) => reply({ error: err.message }));
  });

  // Writing a Dhan watchlist needs Dhan's session and keys, which only exist on
  // tv.dhan.co. Say so rather than pretend.
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.__dhanWL !== "push-watchlist") return;
    post({ __dhanWL: "push-watchlist-result", id: msg.id, error: "Pushing to a Dhan watchlist needs a tv.dhan.co chart tab - this one is TradingView." });
  });

  // ---------- chart ----------

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.__dhanWL !== "set-chart") return;
    const reply = (payload) => post({ __dhanWL: "set-chart-result", id: msg.id, ...payload });
    const symbol = String(msg.symbol || "");
    if (!SYMBOL_RE.test(symbol)) return reply({ error: "Unsupported NSE chart symbol" });
    (async () => {
      const target = (await tvSymbols([symbol])).get(symbol);
      if (!target) throw new Error(`TradingView has no NSE stock matching ${symbol.split(":").at(-1)}`);
      await chart().setSymbol(target);
    })().then(
      () => reply({ ok: true }),
      (err) => reply({ error: (err && err.message) || "TradingView rejected the chart change" })
    );
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.__dhanWL !== "chart-symbol") return;
    const reply = (payload) => post({ __dhanWL: "chart-symbol-result", id: msg.id, ...payload });
    try {
      const now = charted();
      if (now.exchange !== "NSE") throw new Error(`TradeBaba lists hold NSE stocks; this chart is ${now.symbol}`);
      reply({ symbol: panelSymbolFor(now.symbol), name: now.name });
    } catch (err) {
      reply({ error: err.message });
    }
  });

  // ---------- Screener prefetch ----------

  let screenerSeq = 0;
  const screenerPending = new Map();
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__dhanWL !== "response") return;
    const waiting = screenerPending.get(msg.id);
    if (!waiting) return;
    screenerPending.delete(msg.id);
    if (msg.error) waiting.reject(new Error(msg.error));
    else waiting.resolve({ url: msg.url, name: msg.name });
  });
  function resolveScreener(query) {
    return new Promise((resolve, reject) => {
      const id = `tv-${++screenerSeq}`;
      screenerPending.set(id, { resolve, reject });
      post({ __dhanWL: "request", id, symbol: query, page: true });
      setTimeout(() => { if (screenerPending.delete(id)) reject(new Error("screener.in request timed out")); }, SCREENER_TIMEOUT_MS);
    });
  }

  // Same 1s poll main.js uses on Dhan: it also catches layout and tab switches
  // that onSymbolChanged() on one chart would miss. Screener covers Indian
  // listings only, so a NASDAQ chart is highlighted but not looked up there.
  // The charted symbol is reported in the panel's spelling and re-checked each
  // tick, since a Dhan-shaped row may only resolve after the chart moved.
  function watchChart() {
    let last = "", reported = "";
    setInterval(() => {
      let now;
      try { now = charted(); } catch (_) { return; }
      const panel = panelSymbolFor(now.symbol);
      if (panel !== reported) {
        reported = panel;
        post({ __dhanWL: "charted-symbol", symbol: panel });
      }
      if (now.symbol === last) return;
      last = now.symbol;
      if (now.exchange !== "NSE" && now.exchange !== "BSE") return;
      const query = screenerQuery(now);
      if (query) resolveScreener(query).catch((err) => console.warn("[TradeBaba]", err.message));
    }, 1000);
  }

  window.tradebabaTV = { tvSymbols, screenerQuery, charted, search, resolveNames };
  watchChart();
})();
