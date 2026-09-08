// The only place a cross-origin fetch to screener.in can happen: MV3 content
// scripts are subject to the page's CORS, and screener.in sends no
// access-control-allow-origin, so the page itself can never reach it.

const SYMBOL_RE = /^[A-Z0-9&.-]{1,25}$/;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "screener") return;

  // The symbol arrives from a page script, so treat it as untrusted: it is
  // interpolated into a URL path and must not be able to escape it.
  const symbol = String(msg.symbol || "").trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) {
    sendResponse({ error: `refusing to fetch a malformed symbol: ${symbol}` });
    return;
  }

  fetch(`https://www.screener.in/company/${symbol}/`, { credentials: "omit" })
    .then((res) =>
      res.ok ? res.text() : Promise.reject(new Error("http " + res.status))
    )
    .then((html) => sendResponse({ html }))
    .catch((err) => sendResponse({ error: err.message }));

  return true; // keep the channel open for the async reply
});
