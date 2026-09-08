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
    const row = SEG[exchange];
    if (!row) return -1;
    const key = exchange === "IDX" ? "*" : segment;
    return key in row ? row[key] : -1;
  }

  function parseSymbols(text) {
    const seen = new Set();
    const out = [];
    for (const raw of String(text).split(/[\s,;]+/)) {
      const name = raw.trim().toUpperCase();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
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

  async function addSymbols(wId, names, minConfidence = MIN_CONFIDENCE) {
    const hits = (await scan(names)).filter((h) => h.confidence > minConfidence);
    const { stockDetail, unmapped } = resolveHits(hits);
    if (!stockDetail.length) throw new Error("no symbols resolved");
    const added = await api("AddMultipleStock", {
      w_id: wId,
      stock_detail: stockDetail,
    });
    return {
      requested: names.length,
      resolved: stockDetail.length,
      unmapped,
      added,
    };
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

  const WINDOW_LABEL = "6-month";

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
  async function syncFromRepo(log = () => {}) {
    const target = findTarget(await getWatchlists());
    const wId = target.w_id;
    const list = await fetchPublishedList();
    log(`list built ${list.generated_on}: ${list.symbols.length} symbols`);

    // Resolve before clearing. If the scan fails, the watchlist is untouched.
    const hits = (await scan(list.symbols)).filter(
      (h) => h.confidence > MIN_CONFIDENCE
    );
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
      requested: list.symbols.length,
      resolved: stockDetail.length,
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
    select, textarea { width: 100%; box-sizing: border-box; background: #131722;
      color: #e8e8ea; border: 1px solid #363a45; border-radius: 4px; padding: 6px;
      font: inherit; }
    textarea { height: 110px; resize: vertical; font-family: ui-monospace, monospace; }
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
        <button class="launch" id="launch">Bulk add</button>
        <div class="panel" id="panel" hidden>
          <div class="row">
            <h1>Bulk add to watchlist</h1>
            <button class="ghost" id="close">&times;</button>
          </div>
          <div class="row"><select id="lists"><option>loading…</option></select></div>
          <div class="row">
            <textarea id="symbols" placeholder="HDFCBANK, RELIANCE
INFY
TCS"></textarea>
          </div>
          <div class="row">
            <button id="add" disabled>Add</button>
            <button class="ghost" id="refresh">Refresh</button>
          </div>
          <div class="row">
            <button id="sync" disabled>Update watchlist</button>
            <span class="hint" id="synchint">replaces "6-Month Stocks"</span>
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
    const lists = $("lists");
    const logEl = $("log");

    const log = (msg, cls) => {
      const line = document.createElement("div");
      if (cls) line.className = cls;
      line.textContent = msg;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    };

    const setBusy = (busy) => {
      for (const id of ["add", "sync", "refresh"]) $(id).disabled = busy;
    };

    async function loadLists() {
      setBusy(true);
      lists.innerHTML = "<option>loading…</option>";
      try {
        const all = (await selfCheck()).filter((w) => w.w_id > 0);
        lists.innerHTML = "";
        for (const w of all) {
          const opt = document.createElement("option");
          opt.value = w.w_id;
          const used = (w.s_list || []).length;
          opt.textContent = `${w.w_name} (${used}/${MAX_PER_WATCHLIST})`;
          opt.dataset.used = used;
          lists.appendChild(opt);
        }
        setBusy(false);
        $("add").disabled = $("sync").disabled = all.length === 0;
        log(`self-check ok - ${all.length} watchlists`, "ok");
      } catch (err) {
        lists.innerHTML = "<option>unavailable</option>";
        $("refresh").disabled = false;
        log("self-check FAILED: " + err.message, "err");
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
    $("refresh").addEventListener("click", loadLists);

    $("add").addEventListener("click", async () => {
      const names = parseSymbols($("symbols").value);
      const selected = lists.options[lists.selectedIndex];
      if (!names.length) return log("nothing to add", "err");
      const used = Number(selected.dataset.used || 0);
      if (used + names.length > MAX_PER_WATCHLIST) {
        log(
          `warning: ${used} + ${names.length} exceeds the ${MAX_PER_WATCHLIST} cap; the API may reject some`,
          "err"
        );
      }
      setBusy(true);
      log(`resolving ${names.length} symbols…`);
      try {
        const result = await addSymbols(Number(selected.value), names);
        log(`added ${result.resolved} of ${result.requested}`, "ok");
        for (const miss of result.unmapped) {
          log("unmapped segment: " + JSON.stringify(miss), "err");
        }
        await loadLists();
      } catch (err) {
        log("failed: " + err.message, "err");
        setBusy(false);
      }
    });

    $("sync").addEventListener("click", async () => {
      if (
        !window.confirm(
          `Replace everything in "${TARGET_NAME}" with the ${WINDOW_LABEL} ` +
            `NSE IPO list?\n\nIts current contents will be cleared first. ` +
            `Other watchlists are untouched.`
        )
      ) {
        return;
      }
      await runSync("manual");
    });

    async function runSync(mode) {
      setBusy(true);
      log(mode === "auto" ? "checking for a new list…" : "fetching published list…");
      try {
        const result = await syncFromRepo(log);
        rememberSynced(result.generatedOn);
        clearWarning();
        log(
          `synced ${result.resolved} of ${result.requested} into "${result.watchlist}" ` +
            `(list built ${result.generatedOn})`,
          "ok"
        );
        for (const miss of result.unmapped) {
          log("unmapped segment: " + JSON.stringify(miss), "err");
        }
        log("reload the page to see it in the sidebar");
        await loadLists();
        return true;
      } catch (err) {
        log("sync failed: " + err.message, "err");
        raiseWarning();
        setBusy(false);
        return false;
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
    // never clears the watchlist for nothing.
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
      await runSync("auto");
    }

    loadLists().then(autoSync);
  }

  function whenReady() {
    if (window.CryptoJS && window.reqObjectOG && document.documentElement) {
      mountUI();
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
    addSymbols,
    syncFromRepo,
    fetchPublishedList,
    selfCheck,
    segOf,
    parseSymbols,
  };
  whenReady();
})();
