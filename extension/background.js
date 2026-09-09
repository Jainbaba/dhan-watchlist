// The only place a cross-origin fetch to screener.in can happen: MV3 content
// scripts are subject to the page's CORS, and screener.in sends no
// access-control-allow-origin, so the page itself can never reach it.
//
// The chart hands us whatever Dhan displays --
// sometimes a ticker ("AEROPLANE"), sometimes a company name ("PARAG MILK
// FOODS"). screener.in's own search accepts either and returns the canonical
// company URL, so let it do the mapping rather than shipping a symbol index.

const ORIGIN = "https://www.screener.in";
const SEARCH_URL = `${ORIGIN}/api/company/search/`;
// Loose on purpose: company names carry spaces, dots and ampersands. It only
// has to exclude what could derail a URL, since this arrives from page script.
const QUERY_RE = /^[A-Za-z0-9 &.'()-]{1,60}$/;
// The chart symbol shape main.js accepts: NSE equity segment plus a security id.
const CHART_SYMBOL_RE = /^NSEE\d+:[A-Z0-9.&()' -]{1,60}$/;


// Watchlist backup to a secret GitHub gist. The worker is the only place the
// token is read or sent: it never travels through a page, a content script, or
// a message payload, and it only ever goes to api.github.com over TLS.
const GITHUB_API = "https://api.github.com";
const BACKUP_KEY = "tradebaba:github";
const BACKUP_FILE = "tradebaba-watchlist.json";

async function githubConfig() {
  const stored = (await chrome.storage.local.get(BACKUP_KEY))[BACKUP_KEY] || {};
  if (!stored.token) throw new Error("Add a GitHub token in Settings first");
  return stored;
}

async function github(path, method, body, token) {
  const res = await fetch(GITHUB_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error("GitHub rejected the token (401). Check it has the Gists scope.");
  if (res.status === 404) throw new Error("Gist not found (404). Clear the saved gist id to start a new one.");
  if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: http ${res.status}`);
  return res.json();
}

async function pushBackup(model) {
  const config = await githubConfig();
  const files = { [BACKUP_FILE]: { content: JSON.stringify(model, null, 2) } };
  const gist = config.gistId
    ? await github(`/gists/${config.gistId}`, "PATCH", { files }, config.token)
    : await github("/gists", "POST", { description: "TradeBaba watchlists", public: false, files }, config.token);
  const next = { ...config, gistId: gist.id, url: gist.html_url, lastPushedAt: Date.now() };
  await chrome.storage.local.set({ [BACKUP_KEY]: next });
  return { gistId: next.gistId, url: next.url, lastPushedAt: next.lastPushedAt };
}

async function pullBackup() {
  const config = await githubConfig();
  if (!config.gistId) throw new Error("No gist saved yet - back up once first");
  const gist = await github(`/gists/${config.gistId}`, "GET", null, config.token);
  const file = gist.files && gist.files[BACKUP_FILE];
  if (!file) throw new Error(`The gist has no ${BACKUP_FILE}`);
  // A gist over 1MB comes back truncated, with the full body only at raw_url.
  const raw = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  const model = JSON.parse(raw);
  if (!model || !Array.isArray(model.lists) || !model.lists.length) throw new Error("The backup holds no watchlists");
  return { model, url: gist.html_url };
}


// Opening on tv.dhan.co. Chrome only lets an extension open its own side panel
// from a user gesture, so there is no "on navigation" hook to use: what we can
// do is make the panel this tab's panel the moment Dhan loads, and take the
// first gesture the page sees (or the toolbar button, Alt+D, or the context
// menu) as the cue to open it.
const DHAN_PREFIX = "https://tv.dhan.co/";
const AUTO_KEY = "tradebaba:autoOpen";
const isDhan = (url) => String(url || "").startsWith(DHAN_PREFIX);

async function autoOpenEnabled() {
  const stored = (await chrome.storage.local.get(AUTO_KEY))[AUTO_KEY];
  return stored !== false;
}

async function offerPanel(tabId, url) {
  if (!chrome.sidePanel || !chrome.sidePanel.setOptions) return;
  try {
    await chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: isDhan(url) });
  } catch (_) {
    /* the tab closed mid-navigation */
  }
}

// The content scripts only attach on a page load, so an extension that was just
// enabled or updated is not talking to any tab that was already open. Reload the
// Dhan tabs once, rather than leaving the panel silently inert.
function refreshDhanTabs() {
  if (!chrome.tabs || !chrome.tabs.query) return;
  chrome.tabs.query({ url: `${DHAN_PREFIX}*` }, (tabs) => {
    void chrome.runtime.lastError;
    (tabs || []).forEach((tab) => chrome.tabs.reload(tab.id, { bypassCache: false }));
  });
}

if (chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(refreshDhanTabs);
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(refreshDhanTabs);

function openPanel(tabId) {
  if (tabId == null || !chrome.sidePanel || !chrome.sidePanel.open) return;
  // open() rejects when the gesture has already expired; that is expected, and
  // the toolbar button still works, so it must not surface as an error.
  try {
    const opening = chrome.sidePanel.open({ tabId });
    if (opening && opening.catch) opening.catch(() => {});
  } catch (_) {}
}

if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (!info.status && info.url === undefined) return;
    offerPanel(tabId, (tab && tab.url) || info.url);
  });
}

if (chrome.contextMenus) {
  const menu = () => chrome.contextMenus.create({
    id: "tradebaba-open",
    title: "Open TradeBaba",
    contexts: ["page", "action"],
    documentUrlPatterns: [`${DHAN_PREFIX}*`],
  }, () => void chrome.runtime.lastError);
  chrome.runtime.onInstalled.addListener(menu);
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "tradebaba-open") openPanel(tab && tab.id);
  });
}


// Keyboard shortcuts fired while the Dhan chart has focus. The worker cannot
// read the panel's watchlists, so it resolves what is charted and hands the
// panel the verb; the panel owns the model. A command counts as a user gesture,
// so the panel may be opened first when it is closed.
const FLAG_COMMANDS = {
  "flag-red": "red",
  "flag-orange": "orange",
  "flag-yellow": "yellow",
  "flag-green": "green",
  "flag-blue": "blue",
  "flag-none": "",
};

const ask = (tabId, message) =>
  new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (result) => {
      const failed = chrome.runtime.lastError;
      resolve(failed ? { error: failed.message } : result);
    });
  });

// Resolves false when no extension page was listening, which is how a closed
// panel is detected: the same message is then retried once it has opened.
const deliver = (payload) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (reply) => {
      void chrome.runtime.lastError;
      resolve(Boolean(reply && reply.ok));
    });
  });

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command, tab) => {
    const isFlag = command in FLAG_COMMANDS;
    if (command !== "add-to-watchlist" && command !== "next-symbol" && !isFlag) return;
    const tabId = tab && tab.id;
    if (tabId == null) return;
    if (!isDhan(tab.url)) return;
    openPanel(tabId);
    // Stepping through the list needs no symbol from the page: the panel knows
    // which row the chart is on and which one follows it.
    if (command === "next-symbol") {
      const step = { type: "panelCommand", command, symbol: "", name: "", tabId };
      if (!(await deliver(step))) { await new Promise((r) => setTimeout(r, 800)); await deliver(step); }
      return;
    }
    const chart = await ask(tabId, { type: "chartSymbol" });
    const symbol = String((chart && chart.symbol) || "");
    if (!CHART_SYMBOL_RE.test(symbol)) return;
    const payload = { type: "panelCommand", command, symbol, name: (chart && chart.name) || "", tabId };
    if (await deliver(payload)) return;
    await new Promise((r) => setTimeout(r, 800));
    await deliver(payload);
  });
}

if (chrome.sidePanel) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

async function resolveCompany(query) {
  const res = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(query)}`, {
    credentials: "omit",
  });
  if (!res.ok) throw new Error(`search failed: http ${res.status}`);
  const hits = await res.json();
  if (!Array.isArray(hits) || !hits.length) {
    throw new Error(`screener.in has no company matching "${query}"`);
  }
  const { url, name } = hits[0];
  // The path comes back from the network, so confirm it is a relative company
  // path before turning it into a request.
  if (typeof url !== "string" || !url.startsWith("/company/")) {
    throw new Error("unexpected search result shape");
  }
  return { path: url, name: String(name || query) };
}

async function fetchCompanyPage(query) {
  const company = await resolveCompany(query);
  const url = ORIGIN + company.path;
  const res = await fetch(url, { credentials: "omit", cache: "no-store" });
  if (!res.ok) throw new Error(`company page failed: http ${res.status}`);
  return { name: company.name, url, html: await res.text() };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Every panel-to-page request goes through one forward: only the validation
  // differs, and none may reach the tab with an unchecked string.
  if (msg && (msg.type === "setChart" || msg.type === "searchSymbols" || msg.type === "getQuotes" || msg.type === "watchQuotes" || msg.type === "chartSymbol" || msg.type === "bulkResolve" || msg.type === "pushWatchlist")) {
    const tabId = Number(msg.tabId);
    const symbol = String(msg.symbol || "");
    const query = String(msg.query || "").trim();
    const symbols = (Array.isArray(msg.symbols) ? msg.symbols : [])
      .map(String)
      .filter((s) => CHART_SYMBOL_RE.test(s))
      .slice(0, 50);
    const names = (Array.isArray(msg.names) ? msg.names : []).map((n) => String(n).trim()).filter((n) => QUERY_RE.test(n)).slice(0, 200);
    const source = msg.source === "published" || msg.source === "ath" ? msg.source : "";
    const valid = msg.type === "setChart"
      ? CHART_SYMBOL_RE.test(symbol)
      : msg.type === "searchSymbols"
        ? QUERY_RE.test(query)
        : msg.type === "getQuotes"
          ? symbols.length > 0
        : msg.type === "watchQuotes" || msg.type === "chartSymbol"
          ? true
        : msg.type === "pushWatchlist"
          ? Boolean(String(msg.name || "").trim()) && names.length > 0
          : Boolean(source) || names.length > 0;
    if (!Number.isInteger(tabId) || !valid) {
      sendResponse({ error: `Invalid ${msg.type} request` });
      return;
    }
    chrome.tabs.sendMessage(tabId, { type: msg.type, symbol, query, symbols, names, source, name: String(msg.name || "").trim().slice(0, 60) }, (result) => {
      const error = chrome.runtime.lastError;
      sendResponse(error ? { error: error.message } : (result || { ok: true }));
    });
    return true;
  }
  if (msg && (msg.type === "backupPush" || msg.type === "backupPull")) {
    (msg.type === "backupPush" ? pushBackup(msg.model) : pullBackup())
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (msg && msg.type === "openPanel") {
    const tabId = sender.tab && sender.tab.id;
    autoOpenEnabled().then((on) => { if (on) openPanel(tabId); });
    return;
  }
  if (msg && msg.type === "getStock") {
    const key = `stock:${Number(msg.tabId)}`;
    chrome.storage.session.get(key).then((value) => sendResponse(value[key] || null));
    return true;
  }
  if (!msg || msg.type !== "screener") return;

  const query = String(msg.symbol || "").trim();
  if (!QUERY_RE.test(query)) {
    sendResponse({ error: `refusing to look up a malformed symbol: ${query}` });
    return;
  }

  (async () => {
    if (msg.page) return fetchCompanyPage(query);
    const { path, name } = await resolveCompany(query);
    return { name, url: ORIGIN + path };
  })()
    .then((result) => {
      if (result && result.html && sender.tab && sender.tab.id != null) {
        const payload = { ...result, tabId: sender.tab.id };
        chrome.storage.session.set({ [`stock:${sender.tab.id}`]: payload });
        chrome.runtime.sendMessage({ type: "stockData", ...payload }).catch(() => {});
      }
      sendResponse(result);
    })
    .catch((err) => sendResponse({ error: err.message }));

  return true; // keep the channel open for the async reply
});
