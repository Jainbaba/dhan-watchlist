// The only place a cross-origin fetch to screener.in can happen: MV3 content
// scripts are subject to the page's CORS, and screener.in sends no
// access-control-allow-origin, so the page itself can never reach it.
//
// Resolution is two steps because the chart hands us whatever Dhan displays --
// sometimes a ticker ("AEROPLANE"), sometimes a company name ("PARAG MILK
// FOODS"). screener.in's own search accepts either and returns the canonical
// company URL, so let it do the mapping rather than shipping a symbol index.

const ORIGIN = "https://www.screener.in";
const SEARCH_URL = `${ORIGIN}/api/company/search/`;
// Loose on purpose: company names carry spaces, dots and ampersands. It only
// has to exclude what could derail a URL, since this arrives from page script.
const QUERY_RE = /^[A-Za-z0-9 &.'()-]{1,60}$/;

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "screener") return;

  const query = String(msg.symbol || "").trim();
  if (!QUERY_RE.test(query)) {
    sendResponse({ error: `refusing to look up a malformed symbol: ${query}` });
    return;
  }

  (async () => {
    const { path, name } = await resolveCompany(query);
    const page = await fetch(ORIGIN + path, { credentials: "omit" });
    if (!page.ok) throw new Error(`http ${page.status} for ${path}`);
    return { html: await page.text(), name, path };
  })()
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));

  return true; // keep the channel open for the async reply
});
