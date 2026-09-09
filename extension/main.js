// Runs in the MAIN world on https://tv.dhan.co so it can use the page's global
// CryptoJS and window.reqObjectOG, and so requests carry the tv.dhan.co origin
// the API's CORS policy pins. Key material is lifted from bundle3.0.18.js; if
// Dhan rotates it, selfCheck() throws instead of failing silently.

(() => {
  "use strict";

  const SALT = "498960e491150a0fc0f21822a147fd62";
  const IVH = "320ef7705d1030f0a1a55b3dcf676cb8";
  const PASS = "DHAN";
  const BASE = "https://tv-ws.dhan.co/watchlist/";
  // Rolling list of recent NSE mainboard listings, rebuilt daily at 17:00 IST.
  const LIST_URL =
    "https://raw.githubusercontent.com/Jainbaba/dhan-watchlist/main/watchlist.json";
  // Published by ath_watchlist.py: NSE names within 20% of their all-time high.
  // A different file from LIST_URL above, and its symbols carry an "NSE:"
  // prefix that Dhan's search does not take.
  const ATH_URL =
    "https://raw.githubusercontent.com/Jainbaba/dhan-watchlist/main/ath-watchlist.json";
  // The worker resolves chart labels to canonical Screener company URLs.
  const SCREENER_TIMEOUT_MS = 20000;
  const MIN_CONFIDENCE = 60;
  // Dhan holds 250 symbols in one watchlist.
  const DHAN_LIST_CAP = 250;

  // exchange + segment letter -> numeric seg, mirrors fn T() in the bundle
  const SEG = {
    IDX: { "*": 0 },
    NSE: { I: 0, E: 1, D: 2, C: 3, M: 10 },
    BSE: { I: 0, E: 4, D: 8, C: 7, M: 9 },
    MCX: { M: 5 },
    NCDEX: { M: 6 },
  };

  function segOf(exchange, segment) {
    // Mirrors fn T() in the bundle, guard order included: T tests the segment
    // letter for falsiness BEFORE its IDX shortcut, so T("IDX", "") is -1 and
    // not 0. Diverging here would silently map a segment-less index row onto
    // NSE/I instead of rejecting it.
    if (!segment) return -1;
    const row = SEG[exchange];
    if (!row) return -1;
    const key = exchange === "IDX" ? "*" : segment;
    return key in row ? row[key] : -1;
  }

  let key = null;
  function cryptoKey() {
    if (!key) {
      key = CryptoJS.PBKDF2(PASS, CryptoJS.enc.Hex.parse(SALT), {
        keySize: 4,
        iterations: 1000,
      });
    }
    return key;
  }

  const iv = () => CryptoJS.enc.Hex.parse(IVH);

  const encrypt = (obj) =>
    CryptoJS.AES.encrypt(JSON.stringify(obj), cryptoKey(), { iv: iv() })
      .ciphertext.toString(CryptoJS.enc.Base64);

  function decrypt(b64) {
    const params = CryptoJS.lib.CipherParams.create({
      ciphertext: CryptoJS.enc.Base64.parse(b64),
    });
    const plain = CryptoJS.AES.decrypt(params, cryptoKey(), { iv: iv() }).toString(
      CryptoJS.enc.Utf8
    );
    if (!plain) throw new Error("decrypt produced empty output - key rotated?");
    return JSON.parse(plain);
  }

  async function api(path, payload) {
    const session = window.reqObjectOG;
    if (!session) throw new Error("reqObjectOG missing - sign in to tv.dhan.co first");
    // Deliberately NOT requiring session.jwt: the app sends the literal header
    // "Token undefined" when it has none and the server accepts it. Identity is
    // carried by client_id/token_id/entity_id inside the encrypted body, so
    // those are what must be present.
    if (!session.entity_id || !session.token_id) {
      throw new Error(
        "reqObjectOG has no identity fields (keys: " +
          Object.keys(session).join(",") +
          ")"
      );
    }
    // The wrapper the app's own request function injects before encrypting.
    const body = Object.assign({}, payload, {
      client_id: session.entity_id,
      token_id: session.token_id,
      entity_id: session.login_id,
      iv: "",
      web_version: "Chrome Browser",
    });
    const wire = JSON.stringify(
      encodeURIComponent(JSON.stringify(encrypt(body)))
    );
    let res;
    try {
      res = await fetch(BASE + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorisation: "Token " + session.jwt,
          "Access-Control-Allow-Origin": "true",
        },
        body: wire,
      });
    } catch (err) {
      // A CORS rejection surfaces here as an opaque "Failed to fetch".
      throw new Error("network/CORS blocked " + path + ": " + err.message);
    }
    const raw = await res.text();
    console.debug("[dhanWL]", path, res.status, raw.slice(0, 400));
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        "http " + res.status + ", body is not JSON: " + raw.slice(0, 160)
      );
    }
    if (!envelope.data) {
      throw new Error(
        "http " + res.status + ", no data field: " + raw.slice(0, 160)
      );
    }
    // Two nested envelopes: the HTTP body is {data: <cipher>}, and the cipher
    // decrypts to the app-level {status, data, message} that the bundle reads.
    const result = decrypt(envelope.data);
    if (result.status && result.status !== "success") {
      throw new Error(
        path + " returned status=" + result.status +
          (result.message ? ": " + result.message : "")
      );
    }
    if (result.dh_error_code === "DH-9000" || result.message === "Session Invalidated") {
      throw new Error("session invalidated - reload tv.dhan.co and sign in again");
    }
    return result.data;
  }

  const getWatchlists = () => api("getWatchlist", {});
  const scan = (names) => api("ScanWatchlist", { scrip_list: names });

  // The panel needs "NSEE<securityId>:<TICKER>" -- the same shape the chart
  // itself reports. Build it only from fields the hit actually carries: a hit
  // that is not NSE equity, or whose id/ticker is not in the shape setSymbol
  // accepts, is dropped rather than coerced. Never synthesize a security id.
  const TICKER_RE = /^[A-Z0-9.&()' -]{1,60}$/;
  function chartSymbolFromHit(hit) {
    if (!hit || hit.exchange !== "NSE" || hit.segment !== "E") return null;
    const id = String(hit.security_id ?? "");
    if (!/^\d+$/.test(id)) return null;
    const ticker = [hit.symbol, hit.trading_symbol, hit.display_name]
      .map((v) => String(v ?? "").trim().toUpperCase())
      .find((v) => v && TICKER_RE.test(v));
    return ticker
      ? { symbol: `NSEE${id}:${ticker}`, name: String(hit.display_name || ticker).trim() }
      : null;
  }

  function resolveHits(hits) {
    const seen = new Set();
    const stockDetail = [];
    const unmapped = [];
    for (const hit of hits) {
      const dedupeKey = hit.exchange + hit.segment + hit.security_id;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const seg = segOf(hit.exchange, hit.segment);
      if (seg < 0) {
        unmapped.push(hit);
        continue;
      }
      stockDetail.push({ security_id: String(hit.security_id), seg });
    }
    return { stockDetail, unmapped };
  }

  async function fetchList(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`list fetch failed: http ${res.status} for ${url}`);
    const list = await res.json();
    if (!Array.isArray(list.symbols) || !list.symbols.length) {
      throw new Error(`published list has no symbols: ${url}`);
    }
    return list;
  }




  // The chart's symbol is "<exchange><segment><securityId>:<display>", and the
  // display half is sometimes a ticker ("AEROPLANE") and sometimes a company
  // name ("PARAG MILK FOODS"). Keep it whole -- splitting at the first space
  // turned Parag Milk Foods into a lookup for "PARAG", which 404s. screener.in's
  // search resolves either form, so hand it the untouched string.
  function queryFromTvSymbol(symbol) {
    const raw = String(symbol || "").trim();
    const afterExchange = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
    return afterExchange.replace(/\s+/g, " ").trim().toUpperCase();
  }

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

  function resolveScreener(symbol, page = false) {
    return new Promise((resolve, reject) => {
      const id = ++screenerSeq;
      screenerPending.set(id, { resolve, reject });
      window.postMessage(
        { __dhanWL: "request", id, symbol, page },
        window.location.origin
      );
      setTimeout(() => {
        if (screenerPending.delete(id)) {
          reject(new Error("screener.in request timed out"));
        }
      }, SCREENER_TIMEOUT_MS);
    });
  }



  // Mirrors the published list into the target watchlist: whatever aged out of
  // the 6-month window disappears. Destructive by design, so it resolves the
  // target by name itself rather than trusting a caller-supplied id.
  // Names the requested symbols that no confident hit came back for. The scan
  // response does not echo the query, and display_name is not the plain ticker,
  // so match against every string field on the hit and err toward silence: a
  // missed report is better than accusing 48 of 53 symbols of not existing.
  function findMissing(requested, hits) {
    const found = new Set();
    for (const hit of hits) {
      for (const value of Object.values(hit || {})) {
        if (typeof value === "string") found.add(value.trim().toUpperCase());
      }
    }
    return requested.filter((name) => !found.has(name.trim().toUpperCase()));
  }


  async function selfCheck() {
    const lists = await getWatchlists();
    if (!Array.isArray(lists)) {
      throw new Error(
        "expected an array of watchlists, got " +
          JSON.stringify(lists).slice(0, 200)
      );
    }
    return lists;
  }

  // ---------- UI ----------

  const CSS = `
    :host { all: initial; }
    .wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      font: 13px/1.45 -apple-system, system-ui, sans-serif; color: #e8e8ea; }
    .launch { background: #2962ff; color: #fff; border: 0; border-radius: 6px;
      padding: 8px 12px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
    .panel { width: 320px; background: #1e222d; border: 1px solid #363a45;
      border-radius: 8px; padding: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.5); }
    .row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .row + .row { margin-top: 0; }
    h1 { font-size: 13px; margin: 0; flex: 1; font-weight: 600; }
    button { background: #2962ff; color: #fff; border: 0; border-radius: 4px;
      padding: 6px 10px; cursor: pointer; font-size: 12px; }
    button.ghost { background: #2a2e39; }
    button:disabled { opacity: .5; cursor: default; }
    .log { margin-top: 8px; max-height: 120px; overflow: auto; white-space: pre-wrap;
      font-family: ui-monospace, monospace; font-size: 11px; color: #b2b5be; }
    .err { color: #ff6b6b; }
    .ok { color: #4caf50; }
    .hint { font-size: 11px; color: #787b86; flex: 1; }
    .launch.warn { background: #b23c3c; }
  `;





  // ponytail: 1s poll. The widget exposes onSymbolChanged(), but that needs the
  // chart to be ready first and misses layout/tab switches; swap to the event if
  // the poll ever shows up in a profile.
  function watchChartSymbol(onChange) {
    let last = "";
    const check = () => {
      let symbol;
      try {
        const widget = window.dhan_tvWidget;
        const chart = widget && widget.activeChart && widget.activeChart();
        symbol = chart && chart.symbol && chart.symbol();
      } catch (err) {
        return; // widget not ready yet
      }
      const ticker = queryFromTvSymbol(symbol);
      if (ticker && ticker !== last) {
        last = ticker;
        onChange(ticker);
      }
    };
    check();
    setInterval(check, 1000);
  }

  // Read-only prototype control used by the TradeBaba side panel. Dhan's
  // TradingView wrapper exposes setSymbol on the active chart; keep the wire
  // format strict so a panel message cannot send an arbitrary chart request.
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.__dhanWL !== "set-chart") return;
    const symbol = String(msg.symbol || "");
    if (!/^NSEE\d+:[A-Z0-9.&()' -]{1,60}$/.test(symbol)) {
      window.postMessage({ __dhanWL: "set-chart-result", id: msg.id, error: "Unsupported NSE chart symbol" }, window.location.origin);
      return;
    }
    try {
      const chart = window.dhan_tvWidget && window.dhan_tvWidget.activeChart && window.dhan_tvWidget.activeChart();
      if (!chart || typeof chart.setSymbol !== "function") throw new Error("Dhan chart is not ready");
      Promise.resolve(chart.setSymbol(symbol)).then(
        () => window.postMessage({ __dhanWL: "set-chart-result", id: msg.id, ok: true }, window.location.origin),
        (err) => window.postMessage({ __dhanWL: "set-chart-result", id: msg.id, error: err.message || "Dhan rejected the chart change" }, window.location.origin)
      );
    } catch (err) {
      window.postMessage({ __dhanWL: "set-chart-result", id: msg.id, error: err.message }, window.location.origin);
    }
  });

  // Bulk resolve for the panel's paste/import box. Same read-only ScanWatchlist
  // the repo sync uses, and the same confidence bar and missing-name report --
  // an unresolved ticker is named, never silently dropped or guessed at.
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.__dhanWL !== "bulk-resolve") return;
    const reply = (payload) =>
      window.postMessage({ __dhanWL: "bulk-resolve-result", id: msg.id, ...payload }, window.location.origin);
    (async () => {
      const names = msg.source
        ? (await fetchList(msg.source === "ath" ? ATH_URL : LIST_URL)).symbols.map((n) => String(n).split(":").at(-1).trim()).filter(Boolean)
        : (Array.isArray(msg.names) ? msg.names : []).map((n) => String(n).trim()).filter(Boolean).slice(0, 200);
      if (!names.length) return reply({ hits: [], missing: [], requested: 0 });
      const raw = (await scan(names)).filter((h) => h.confidence > MIN_CONFIDENCE);
      const seen = new Set();
      const hits = raw.map(chartSymbolFromHit).filter((h) => h && !seen.has(h.symbol) && seen.add(h.symbol));
      reply({ hits, missing: findMissing(names, raw), requested: names.length });
    })().catch((err) => reply({ error: err.message }));
  });

  // Quotes for the panel's Last/Chg/Chg% columns. The only trustworthy source on
  // this page is the datafeed Dhan already hands its TradingView terminal: a
  // terminal datafeed implements getQuotes(). Feature-detect it and report its
  // absence -- Screener's "Current Price" is a stale page scrape, not an LTP,
  // and a fabricated zero change is worse than an empty column.
  function datafeed() {
    const widget = window.dhan_tvWidget;
    return [
      widget && widget._options && widget._options.datafeed,
      widget && widget.datafeed,
      window.dhanDatafeed,
    ].find((feed) => feed && (typeof feed.getQuotes === "function" || typeof feed.searchSymbols === "function")) || null;
  }

  const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.__dhanWL !== "get-quotes") return;
    const reply = (payload) =>
      window.postMessage({ __dhanWL: "get-quotes-result", id: msg.id, ...payload }, window.location.origin);
    const symbols = (Array.isArray(msg.symbols) ? msg.symbols : []).map(String).slice(0, 50);
    if (!symbols.length) return reply({ quotes: [] });
    const feed = datafeed();
    if (!feed || typeof feed.getQuotes !== "function") return reply({ error: "This Dhan chart exposes no quote feed, so Last/Chg stay empty." });
    try {
      feed.getQuotes(
        symbols,
        (rows) =>
          reply({
            quotes: (Array.isArray(rows) ? rows : [])
              .filter((row) => row && row.s === "ok" && row.v)
              .map((row) => ({
                symbol: String(row.n || ""),
                last: finite(row.v.lp),
                change: finite(row.v.ch),
                changePercent: finite(row.v.chp),
              })),
          }),
        (err) => reply({ error: String((err && err.message) || err || "quote lookup failed") })
      );
    } catch (err) {
      reply({ error: err.message });
    }
  });

  // Live ticks. The datafeed the page already runs is the only stream we can
  // read without new credentials, and subscribeQuotes is its tick API. Ticks
  // are batched once a second: the panel repaints a handful of cells, it does
  // not need every print.
  let tickGuid = null, tickBuffer = new Map(), tickTimer = null;
  function flushTicks() {
    if (!tickBuffer.size) return;
    const quotes = [...tickBuffer.values()];
    tickBuffer = new Map();
    window.postMessage({ __dhanWL: "quote-tick", quotes }, window.location.origin);
  }
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.__dhanWL !== "watch-quotes") return;
    const reply = (payload) =>
      window.postMessage({ __dhanWL: "watch-quotes-result", id: msg.id, ...payload }, window.location.origin);
    const feed = datafeed();
    const symbols = (Array.isArray(msg.symbols) ? msg.symbols : []).map(String).slice(0, 50);
    if (!feed || typeof feed.subscribeQuotes !== "function") return reply({ streaming: false });
    try {
      if (tickGuid && typeof feed.unsubscribeQuotes === "function") feed.unsubscribeQuotes(tickGuid);
      tickGuid = null;
      clearInterval(tickTimer);
      tickTimer = null;
      if (!symbols.length) return reply({ streaming: false });
      tickGuid = `tradebaba-${Date.now()}`;
      feed.subscribeQuotes(symbols, symbols, (rows) => {
        (Array.isArray(rows) ? rows : []).forEach((row) => {
          if (!row || row.s !== "ok" || !row.v) return;
          const symbol = String(row.n || "");
          const previous = tickBuffer.get(symbol) || {};
          tickBuffer.set(symbol, {
            symbol,
            last: finite(row.v.lp) ?? previous.last ?? null,
            change: finite(row.v.ch) ?? previous.change ?? null,
            changePercent: finite(row.v.chp) ?? previous.changePercent ?? null,
          });
        });
      }, tickGuid);
      tickTimer = setInterval(flushTicks, 1000);
      reply({ streaming: true });
    } catch (err) {
      reply({ streaming: false, error: err.message });
    }
  });

  // Read-only symbol lookup for the panel's search box: ScanWatchlist is Dhan's
  // own search and writes nothing. Personal watchlists are never touched here.
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.__dhanWL !== "search-symbols") return;
    const reply = (payload) =>
      window.postMessage({ __dhanWL: "search-symbols-result", id: msg.id, ...payload }, window.location.origin);
    const query = String(msg.query || "").trim();
    if (!query) return reply({ hits: [] });
    // The datafeed's own searchSymbols is what Dhan's chart search box uses, so
    // it returns a ranked list. ScanWatchlist resolves a name to one scrip, so
    // it is the fallback, not the first choice.
    feedSearch(query)
      .then((rows) => {
        const seen = new Set();
        const hits = rows.map(chartSymbolFromSearch).filter((h) => h && !seen.has(h.symbol) && seen.add(h.symbol));
        if (hits.length) return reply({ hits: hits.slice(0, 20) });
        return scanSearch(query).then(reply, (err) => reply({ error: err.message }));
      })
      .catch((err) => reply({ error: err.message }));
  });

  const CHART_SYMBOL_RE = /^NSEE\d+:[A-Z0-9.&()' -]{1,60}$/;
  function chartSymbolFromSearch(row) {
    const symbol = [row && row.ticker, row && row.full_name, row && row.symbol]
      .map((v) => String(v ?? "").trim().toUpperCase())
      .find((v) => CHART_SYMBOL_RE.test(v));
    return symbol ? { symbol, name: String((row && row.description) || symbol.split(":").at(-1)).trim() } : null;
  }
  // Datafeed callbacks are not promises and some implementations never call
  // back; cap the wait so the panel falls through to the resolver instead.
  function feedSearch(query) {
    return new Promise((resolve) => {
      const feed = datafeed();
      if (!feed || typeof feed.searchSymbols !== "function") return resolve([]);
      let settled = false;
      const done = (rows) => { if (settled) return; settled = true; resolve(Array.isArray(rows) ? rows : []); };
      setTimeout(() => done([]), 3000);
      try { feed.searchSymbols(query, "", "", done); } catch (_) { done([]); }
    });
  }
  function scanSearch(query) {
    return scan([query])
      .then((hits) => {
        const rows = (Array.isArray(hits) ? hits : [])
          .slice()
          .sort((a, b) => (Number(b?.confidence) || 0) - (Number(a?.confidence) || 0))
          .map(chartSymbolFromHit)
          .filter(Boolean);
        const seen = new Set();
        return { hits: rows.filter((r) => !seen.has(r.symbol) && seen.add(r.symbol)).slice(0, 20) };
      });
  }

  // What the chart is showing right now, in the exact shape setSymbol accepts.
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.__dhanWL !== "chart-symbol") return;
    const reply = (payload) =>
      window.postMessage({ __dhanWL: "chart-symbol-result", id: msg.id, ...payload }, window.location.origin);
    try {
      const widget = window.dhan_tvWidget;
      const chart = widget && widget.activeChart && widget.activeChart();
      const symbol = chart && chart.symbol && chart.symbol();
      if (!symbol) throw new Error("Dhan chart is not ready");
      reply({ symbol: String(symbol), name: queryFromTvSymbol(symbol) });
    } catch (err) {
      reply({ error: err.message });
    }
  });

  // Push a local list into a Dhan watchlist. This is the only write TradeBaba
  // makes to a Dhan watchlist, it targets one list by name, and it always
  // replaces: the panel confirms the overwrite before asking. Creating a
  // watchlist is NOT done here - no create endpoint has been verified from
  // captured traffic, and guessing one would be a write to an unknown API.
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.__dhanWL !== "push-watchlist") return;
    const reply = (payload) =>
      window.postMessage({ __dhanWL: "push-watchlist-result", id: msg.id, ...payload }, window.location.origin);
    (async () => {
      const wanted = String(msg.name || "").trim();
      const names = (Array.isArray(msg.names) ? msg.names : []).map((n) => String(n).trim()).filter(Boolean);
      if (!wanted) throw new Error("no watchlist name given");
      if (!names.length) throw new Error("that watchlist has no symbols");
      if (names.length > DHAN_LIST_CAP) throw new Error(`Dhan holds ${DHAN_LIST_CAP} symbols per watchlist; this one has ${names.length}`);
      const lists = await getWatchlists();
      const target = (Array.isArray(lists) ? lists : []).find(
        (w) => String(w.w_name || "").trim().toLowerCase() === wanted.toLowerCase()
      );
      if (!target) {
        throw new Error(
          `Dhan has no watchlist named "${wanted}" - create it in Dhan first ` +
            `(found: ${(lists || []).map((w) => w.w_name).join(", ") || "none"})`
        );
      }
      // Resolve before clearing, so a failed lookup leaves Dhan untouched.
      const hits = (await scan(names)).filter((h) => h.confidence > MIN_CONFIDENCE);
      const { stockDetail, unmapped } = resolveHits(hits);
      if (!stockDetail.length) throw new Error("nothing resolved - Dhan watchlist left untouched");
      await api("clearWatch", { w_id: target.w_id });
      await api("AddMultipleStock", { w_id: target.w_id, stock_detail: stockDetail });
      reply({ watchlist: target.w_name, pushed: stockDetail.length, requested: names.length, missing: findMissing(names, hits), unmapped: unmapped.length });
    })().catch((err) => reply({ error: err.message }));
  });

  function whenReady() {
    // reqObjectOG appears as an empty object before the app populates it, so
    // wait for the identity fields themselves rather than the bare object.
    const session = window.reqObjectOG;
    if (
      window.CryptoJS &&
      session &&
      session.entity_id &&
      session.token_id &&
      document.documentElement
    ) {
      // Keep the side panel's per-tab cache current even while it is closed.
      watchChartSymbol((ticker) => resolveScreener(ticker, true).catch((err) => console.warn("[TradeBaba]", err.message)));
      return;
    }
    setTimeout(whenReady, 500);
  }

  window.dhanWL = {
    api,
    encrypt,
    decrypt,
    getWatchlists,
    scan,
    findMissing,
    queryFromTvSymbol,
    selfCheck,
    segOf,
    chartSymbolFromHit,
    datafeed,
    chartSymbolFromSearch,
  };
  whenReady();
})();
