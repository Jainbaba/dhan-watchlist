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
  // Rolling list of recent NSE mainboard listings, rebuilt daily at 09:00 IST.
  const LIST_URL =
    "https://raw.githubusercontent.com/Jainbaba/dhan-watchlist/main/watchlist.json";
  const MAX_PER_WATCHLIST = 250;
  // The one watchlist this extension is allowed to clear. Matched by name so a
  // destructive sync can never land on a hand-curated list; if it is missing we
  // stop rather than create it.
  const TARGET_NAME = "6-Month Stocks";
  const LAST_SYNC_KEY = "dhanWL:lastSyncedOn";
  const SYNC_LOCK_KEY = "dhanWL:syncLock";
  // Long enough to cover a slow sync, short enough that a tab closed mid-sync
  // cannot wedge the lock for more than a couple of minutes.
  const SYNC_LOCK_MS = 120000;
  // Shareholding comes from screener.in, fetched by the background worker
  // because the page's own origin can never reach it.
  const SCREENER_TIMEOUT_MS = 20000;
  const SHAREHOLDING_PERIODS = 5;
  const MIN_CONFIDENCE = 60;

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

  async function fetchPublishedList() {
    const res = await fetch(LIST_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("list fetch failed: http " + res.status);
    const list = await res.json();
    if (!Array.isArray(list.symbols) || !list.symbols.length) {
      throw new Error("published list has no symbols");
    }
    return list;
  }

  // The repo owns what the list contains, so take the wording from the data
  // rather than restating it here where the two could drift apart.
  const describeWindow = (days) =>
    Number.isFinite(days) ? `${Math.round(days / 30.44)}-month` : "published";

  // Per-browser memory of which published build was last applied. Best-effort:
  // a blocked or cleared store just means the next load syncs again.
  function lastSynced() {
    try {
      return localStorage.getItem(LAST_SYNC_KEY);
    } catch (err) {
      return null;
    }
  }
  function rememberSynced(generatedOn) {
    try {
      localStorage.setItem(LAST_SYNC_KEY, generatedOn);
    } catch (err) {
      /* private window or blocked storage - re-syncing is harmless */
    }
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

  // Reads the shareholding table out of a screener.in company page. The browser
  // has a real HTML parser, so use it rather than pattern-matching markup.
  function parseShareholding(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const section = doc.getElementById("shareholding");
    if (!section) throw new Error("no shareholding section on that page");
    const table = section.querySelector("table");
    if (!table) throw new Error("shareholding section had no table");

    const periods = Array.from(table.querySelectorAll("thead th"))
      .map((th) => th.textContent.trim())
      .filter(Boolean);
    const rows = Array.from(table.querySelectorAll("tbody tr"))
      .map((tr) => {
        const cells = Array.from(tr.querySelectorAll("th,td")).map((cell) =>
          cell.textContent.replace(/\s+/g, " ").trim()
        );
        return {
          // Screener suffixes expandable rows with a "+".
          label: (cells[0] || "").replace(/\s*\+$/, ""),
          values: cells.slice(1),
        };
      })
      .filter((row) => row.label && row.values.length);
    if (!rows.length) throw new Error("shareholding table had no rows");
    return { periods, rows };
  }

  // Keeps only the most recent columns, so a company with years of history and
  // one freshly listed a quarter ago both render in the same small card.
  function trimToRecent(parsed, keep = SHAREHOLDING_PERIODS) {
    const drop = Math.max(0, parsed.periods.length - keep);
    return {
      periods: parsed.periods.slice(drop),
      rows: parsed.rows.map((row) => ({
        label: row.label,
        values: row.values.slice(drop),
      })),
    };
  }

  // Rows where a rising number is read as bullish, and where it is read as
  // bearish. Anything unlisted (Government, No. of Shareholders) stays neutral.
  const HIGHER_IS_GOOD = /^(FII|DII)/i;
  const HIGHER_IS_BAD = /^(PROMOTER|PUBLIC)/i;

  // "55.37%" -> 55.37, "3,55,321" -> 355321 (Indian grouping), "" -> NaN.
  function toNumber(value) {
    const cleaned = String(value == null ? "" : value).replace(/[%,\s\u00a0]/g, "");
    if (!cleaned) return NaN;
    return Number(cleaned);
  }

  // Tone for one cell against the column before it: "pos", "neg" or "" for flat,
  // unparseable, or a row with no directional meaning.
  function cellTone(label, previous, current) {
    const before = toNumber(previous);
    const after = toNumber(current);
    if (!Number.isFinite(before) || !Number.isFinite(after)) return "";
    if (after === before) return "";
    const rising = after > before;
    if (HIGHER_IS_GOOD.test(label)) return rising ? "pos" : "neg";
    if (HIGHER_IS_BAD.test(label)) return rising ? "neg" : "pos";
    return "";
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
    else waiting.resolve({ html: msg.html, name: msg.name });
  });

  function fetchScreenerPage(symbol) {
    return new Promise((resolve, reject) => {
      const id = ++screenerSeq;
      screenerPending.set(id, { resolve, reject });
      window.postMessage(
        { __dhanWL: "request", id, symbol },
        window.location.origin
      );
      setTimeout(() => {
        if (screenerPending.delete(id)) {
          reject(new Error("screener.in request timed out"));
        }
      }, SCREENER_TIMEOUT_MS);
    });
  }

  // Once the bridge is orphaned nothing can succeed until the page reloads, so
  // stop asking on every symbol change and keep saying why.
  let bridgeDead = false;

  const shareholdingCache = new Map();
  async function getShareholding(query) {
    if (bridgeDead) throw new Error("extension was reloaded - refresh the page");
    if (shareholdingCache.has(query)) return shareholdingCache.get(query);
    let html, name;
    try {
      ({ html, name } = await fetchScreenerPage(query));
    } catch (err) {
      if (/reloaded/.test(err.message)) bridgeDead = true;
      throw err;
    }
    const parsed = trimToRecent(parseShareholding(html));
    parsed.company = name || query;
    shareholdingCache.set(query, parsed);
    return parsed;
  }

  // localStorage is shared across tabs of one origin, so a timestamped claim
  // keeps two tabs from interleaving clear-and-refill. If storage is blocked we
  // proceed: syncing twice is better than a tab that can never sync at all.
  function claimSyncLock() {
    try {
      const held = Number(localStorage.getItem(SYNC_LOCK_KEY));
      if (Number.isFinite(held) && held > 0 && Date.now() - held < SYNC_LOCK_MS) {
        return false;
      }
      localStorage.setItem(SYNC_LOCK_KEY, String(Date.now()));
      return true;
    } catch (err) {
      return true;
    }
  }
  function releaseSyncLock() {
    try {
      localStorage.removeItem(SYNC_LOCK_KEY);
    } catch (err) {
      /* nothing to release */
    }
  }

  function findTarget(lists) {
    const wanted = TARGET_NAME.trim().toLowerCase();
    const match = lists.find(
      (w) => String(w.w_name || "").trim().toLowerCase() === wanted
    );
    if (!match) {
      throw new Error(
        `no watchlist named "${TARGET_NAME}" - create it in Dhan first ` +
          `(found: ${lists.map((w) => w.w_name).join(", ") || "none"})`
      );
    }
    return match;
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

  async function syncFromRepo(log = () => {}, prefetched = null) {
    const target = findTarget(await getWatchlists());
    const wId = target.w_id;
    const list = prefetched || (await fetchPublishedList());
    log(`list built ${list.generated_on}: ${list.symbols.length} symbols`);

    // Resolve before clearing. If the scan fails, the watchlist is untouched.
    const hits = (await scan(list.symbols)).filter(
      (h) => h.confidence > MIN_CONFIDENCE
    );
    const missing = findMissing(list.symbols, hits);
    const { stockDetail, unmapped } = resolveHits(hits);
    if (!stockDetail.length) throw new Error("nothing resolved - not clearing");
    log(`resolved ${stockDetail.length}, clearing watchlist…`);

    await api("clearWatch", { w_id: wId });
    const added = await api("AddMultipleStock", {
      w_id: wId,
      stock_detail: stockDetail,
    });
    return {
      watchlist: target.w_name,
      generatedOn: list.generated_on,
      windowDays: list.window_days,
      requested: list.symbols.length,
      resolved: stockDetail.length,
      missing,
      unmapped,
      added,
    };
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

  function buildPanel() {
    const host = document.createElement("div");
    host.id = "dhan-bulk-add-root";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap">
        <button class="launch" id="launch">Watchlist sync</button>
        <div class="panel" id="panel" hidden>
          <div class="row">
            <h1>${TARGET_NAME}</h1>
            <button class="ghost" id="close">&times;</button>
          </div>
          <div class="row"><span class="hint" id="status">checking…</span></div>
          <div class="row">
            <button id="sync" disabled>Update watchlist</button>
            <button class="ghost" id="refresh">Refresh</button>
          </div>
          <div class="log" id="log"></div>
        </div>
      </div>`;
    document.documentElement.appendChild(host);
    return root;
  }

  function mountUI() {
    const root = buildPanel();
    const $ = (id) => root.getElementById(id);
    const panel = $("panel");
    const logEl = $("log");

    const log = (msg, cls) => {
      const line = document.createElement("div");
      if (cls) line.className = cls;
      line.textContent = msg;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    };

    const setBusy = (busy) => {
      for (const id of ["sync", "refresh"]) $(id).disabled = busy;
    };

    // Reports the target watchlist's current size, and doubles as the self-check:
    // reaching it means the session, the crypto and the envelope all still work.
    async function refreshStatus() {
      setBusy(true);
      $("status").textContent = "checking…";
      try {
        const target = findTarget(await selfCheck());
        const used = (target.s_list || []).length;
        $("status").textContent = `${used} of ${MAX_PER_WATCHLIST} symbols`;
        setBusy(false);
        return target;
      } catch (err) {
        $("status").textContent = "unavailable";
        $("refresh").disabled = false;
        log(err.message, "err");
        raiseWarning();
        return null;
      }
    }

    $("launch").addEventListener("click", () => {
      panel.hidden = false;
      $("launch").hidden = true;
    });
    $("close").addEventListener("click", () => {
      panel.hidden = true;
      $("launch").hidden = false;
    });
    $("refresh").addEventListener("click", refreshStatus);

    $("sync").addEventListener("click", async () => {
      setBusy(true);
      let list;
      try {
        list = await fetchPublishedList();
      } catch (err) {
        log("could not fetch the list: " + err.message, "err");
        setBusy(false);
        return;
      }
      setBusy(false);
      if (
        !window.confirm(
          `Replace everything in "${TARGET_NAME}" with the ` +
            `${describeWindow(list.window_days)} NSE IPO list ` +
            `(${list.symbols.length} symbols)?\n\n` +
            `Its current contents will be cleared first. ` +
            `Other watchlists are untouched.`
        )
      ) {
        return;
      }
      await runSync("manual", list);
    });

    async function runSync(mode, list) {
      if (!claimSyncLock()) {
        if (mode === "manual") {
          log("another tab is syncing - try again in a moment", "err");
        }
        return false;
      }
      setBusy(true);
      log(mode === "auto" ? "new list found, syncing…" : "syncing…");
      try {
        const result = await syncFromRepo(log, list);
        rememberSynced(result.generatedOn);
        clearWarning();
        log(
          `synced ${result.resolved} of ${result.requested} into ` +
            `"${result.watchlist}" (list built ${result.generatedOn})`,
          "ok"
        );
        for (const name of result.missing) {
          log(`not found in Dhan search: ${name}`, "err");
        }
        for (const miss of result.unmapped) {
          log("unmapped segment: " + JSON.stringify(miss), "err");
        }
        if (result.missing.length || result.unmapped.length) raiseWarning();
        log("reload the page to see it in the sidebar");
        await refreshStatus();
        return true;
      } catch (err) {
        log("sync failed: " + err.message, "err");
        raiseWarning();
        setBusy(false);
        return false;
      } finally {
        releaseSyncLock();
      }
    }

    function raiseWarning() {
      $("launch").classList.add("warn");
      $("launch").textContent = "Bulk add \u26a0";
    }
    function clearWarning() {
      $("launch").classList.remove("warn");
      $("launch").textContent = "Bulk add";
    }

    // Runs unattended on page load. Skips entirely when the published list is
    // the same one already applied, so a normal visit costs one cached GET and
    // never clears the watchlist for nothing. A watchlist edited by hand is left
    // alone until the next build, on the assumption the edit was deliberate.
    async function autoSync() {
      let list;
      try {
        list = await fetchPublishedList();
      } catch (err) {
        log("auto-sync: " + err.message, "err");
        raiseWarning();
        return;
      }
      if (lastSynced() === list.generated_on) {
        log(`already on the ${list.generated_on} list - nothing to do`);
        return;
      }
      await runSync("auto", list);
    }

    refreshStatus().then(autoSync);
  }


  const CARD_CSS = `
    :host { all: initial; }
    .card { position: fixed; left: 16px; bottom: 16px; z-index: 2147483646;
      max-width: min(620px, calc(100vw - 32px));
      background: #1e222d; border: 1px solid #363a45; border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,.5); overflow: hidden;
      font: 11px/1.35 -apple-system, system-ui, sans-serif; color: #d1d4dc; }
    .head { display: flex; align-items: center; gap: 8px;
      padding: 7px 9px; border-bottom: 1px solid #363a45; }
    .head b { flex: 1; font-size: 12px; color: #e8e8ea; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; }
    .head .src { font-size: 10px; color: #5d606b; }
    .head button { background: transparent; color: #787b86; border: 0;
      border-radius: 3px; padding: 1px 5px; cursor: pointer; font-size: 13px;
      line-height: 1; }
    .head button:hover { background: #2a2e39; color: #e8e8ea; }
    .body { padding: 4px 9px 8px; overflow-x: auto; }
    table { border-collapse: collapse; }
    th, td { text-align: right; padding: 2px 0 2px 14px; white-space: nowrap;
      font-variant-numeric: tabular-nums; }
    th:first-child, td:first-child { text-align: left; padding-left: 0;
      color: #b2b5be; }
    thead th { color: #787b86; font-weight: 400; font-size: 10px;
      padding-bottom: 4px; border-bottom: 1px solid #2a2e39; }
    tbody tr:first-child td { padding-top: 5px; }
    td.pos { color: #26a69a; }
    td.neg { color: #ef5350; }
    .msg { color: #787b86; padding: 4px 0; }
    .msg.err { color: #ef5350; white-space: normal; }
  `;

  function mountShareholding() {
    const host = document.createElement("div");
    host.id = "dhan-shareholding-root";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${CARD_CSS}</style>
      <div class="card" id="card">
        <div class="head">
          <b id="sym">\u2014</b>
          <span class="src">screener.in</span>
          <button id="hide" title="hide">&times;</button>
        </div>
        <div class="body" id="body"><div class="msg">waiting for a chart\u2026</div></div>
      </div>`;
    document.documentElement.appendChild(host);

    const card = root.getElementById("card");
    const body = root.getElementById("body");
    const symLabel = root.getElementById("sym");
    root.getElementById("hide").addEventListener("click", () => {
      card.hidden = true;
    });

    const message = (text, cls) => {
      body.innerHTML = "";
      const div = document.createElement("div");
      div.className = cls ? `msg ${cls}` : "msg";
      div.textContent = text;
      body.appendChild(div);
    };

    function renderTable(data) {
      body.innerHTML = "";
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const label of ["", ...data.periods]) {
        const th = document.createElement("th");
        th.textContent = label;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (const row of data.rows) {
        const tr = document.createElement("tr");
        const label = document.createElement("td");
        label.textContent = row.label;
        tr.appendChild(label);
        row.values.forEach((value, index) => {
          const td = document.createElement("td");
          td.textContent = value;
          // The first column has nothing to compare against.
          const tone = index === 0 ? "" : cellTone(row.label, row.values[index - 1], value);
          if (tone) td.className = tone;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      body.appendChild(table);
    }

    let showing = "";
    async function show(ticker) {
      showing = ticker;
      card.hidden = false;
      symLabel.textContent = ticker;
      if (!shareholdingCache.has(ticker)) message("loading\u2026");
      try {
        const data = await getShareholding(ticker);
        if (showing !== ticker) return; // chart moved on while we waited
        if (data.company) symLabel.textContent = data.company;
        renderTable(data);
      } catch (err) {
        if (showing !== ticker) return;
        message(err.message, "err");
      }
    }

    watchChartSymbol(show);
  }

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
      mountUI();
      mountShareholding();
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
    syncFromRepo,
    fetchPublishedList,
    findMissing,
    queryFromTvSymbol,
    parseShareholding,
    cellTone,
    toNumber,
    trimToRecent,
    getShareholding,
    describeWindow,
    claimSyncLock,
    releaseSyncLock,
    selfCheck,
    segOf,
  };
  whenReady();
})();
