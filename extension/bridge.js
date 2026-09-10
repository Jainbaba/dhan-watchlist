// Isolated-world relay. main.js runs in the MAIN world so it can read the
// TradingView widget, but only an isolated content script can talk to the
// background worker. This does nothing else.

const ORPHANED = "extension was reloaded - refresh the page";

// One relay for every panel request that the MAIN world answers: same
// correlation id, same timeout, so a new request type never grows its own
// half-correct copy of this.
const RELAY = {
  setChart: { request: "set-chart", result: "set-chart-result", timeout: "Dhan chart change timed out" },
  searchSymbols: { request: "search-symbols", result: "search-symbols-result", timeout: "Dhan symbol search timed out" },
  getQuotes: { request: "get-quotes", result: "get-quotes-result", timeout: "Dhan quote lookup timed out" },
  watchQuotes: { request: "watch-quotes", result: "watch-quotes-result", timeout: "Dhan quote stream did not answer" },
  chartSymbol: { request: "chart-symbol", result: "chart-symbol-result", timeout: "Dhan did not report the charted symbol" },
  pushWatchlist: { request: "push-watchlist", result: "push-watchlist-result", timeout: "Dhan did not finish the watchlist push", ms: 30000 },
  bulkResolve: { request: "bulk-resolve", result: "bulk-resolve-result", timeout: "Dhan bulk lookup timed out", ms: 120000 },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const route = msg && RELAY[msg.type];
  if (!route) return;
  const id = `${route.request}-${Date.now()}-${Math.random()}`;
  let settled = false;
  const onResult = (event) => {
    if (event.source !== window || !event.data || event.data.__dhanWL !== route.result || event.data.id !== id) return;
    window.removeEventListener("message", onResult);
    settled = true;
    const { __dhanWL, id: _id, ...payload } = event.data;
    sendResponse(payload);
  };
  window.addEventListener("message", onResult);
  window.postMessage({ __dhanWL: route.request, id, symbol: msg.symbol, query: msg.query, symbols: msg.symbols, names: msg.names, source: msg.source, name: msg.name }, window.location.origin);
  setTimeout(() => { if (!settled) { settled = true; window.removeEventListener("message", onResult); sendResponse({ error: route.timeout }); } }, route.ms || 5000);
  return true;
});

// Ticks are pushed, not requested, so they take the broadcast path rather than
// the request/response relay above. An orphaned script has no runtime left, so
// a failed send is expected and ignored.
const BROADCAST = { "quote-tick": "quoteTick", "charted-symbol": "chartedSymbol" };
window.addEventListener("message", (event) => {
  const type = event.source === window && event.data && BROADCAST[event.data.__dhanWL];
  if (!type) return;
  if (!chrome.runtime || !chrome.runtime.id) return;
  const { __dhanWL, ...payload } = event.data;
  try { chrome.runtime.sendMessage({ type, ...payload }, () => void chrome.runtime.lastError); } catch (_) {}
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.__dhanWL !== "request") return;

  const reply = (payload) =>
    window.postMessage(
      { __dhanWL: "response", id: msg.id, ...payload },
      window.location.origin
    );

  // Reloading or updating the extension orphans this script: it keeps running
  // in the page, but chrome.runtime is gone and every call throws. Report that
  // instead of letting the page wait on a promise that can never settle.
  if (!chrome.runtime || !chrome.runtime.id) {
    reply({ error: ORPHANED });
    return;
  }

  try {
    chrome.runtime.sendMessage(
      { type: "screener", symbol: msg.symbol, page: Boolean(msg.page) },
      (res) => {
        const failed = chrome.runtime.lastError;
        reply({
          url: res && res.url,
          name: res && res.name,
          html: res && res.html,
          error: failed
            ? (/Receiving end does not exist|Could not establish connection|context invalidated/i.test(failed.message)
              ? "Screener background worker is unavailable. Reload the extension in chrome://extensions (or brave://extensions), then refresh Dhan."
              : failed.message)
            : res ? res.error : "Screener returned no response. Try again.",
        });
      }
    );
  } catch (err) {
    reply({ error: ORPHANED });
  }
});

// The panel cannot open itself on navigation, so the page's first interaction
// is borrowed as the gesture. Once per page, capture phase so a handled click
// still counts, and silent if the worker declines.
let panelAsked = false;
function askPanel() {
  if (panelAsked) return;
  panelAsked = true;
  document.removeEventListener("pointerdown", askPanel, true);
  document.removeEventListener("keydown", askPanel, true);
  if (!chrome.runtime || !chrome.runtime.id) return;
  try {
    chrome.runtime.sendMessage({ type: "openPanel" }, () => void chrome.runtime.lastError);
  } catch (_) {}
}
document.addEventListener("pointerdown", askPanel, true);
document.addEventListener("keydown", askPanel, true);
