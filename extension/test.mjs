// node test.mjs            -> pure logic + crypto self-consistency
// node test.mjs /tmp/dhan.har -> also decrypts real captured traffic (decisive)
import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const SALT = "498960e491150a0fc0f21822a147fd62";
const IVH = "320ef7705d1030f0a1a55b3dcf676cb8";
const KEY = crypto.pbkdf2Sync("DHAN", Buffer.from(SALT, "hex"), 1000, 16, "sha1");
const IV = Buffer.from(IVH, "hex");

const decrypt = (b64) => {
  const d = crypto.createDecipheriv("aes-128-cbc", KEY, IV);
  return Buffer.concat([d.update(Buffer.from(b64, "base64")), d.final()]).toString("utf8");
};
const encrypt = (text) => {
  const c = crypto.createCipheriv("aes-128-cbc", KEY, IV);
  return Buffer.concat([c.update(text, "utf8"), c.final()]).toString("base64");
};

// --- load main.js without a DOM so whenReady() never mounts ---
globalThis.window = {
  addEventListener() {},
  postMessage() {},
  location: { origin: "https://tv.dhan.co" },
};
globalThis.document = { documentElement: null };
// Minimal localStorage so the cross-tab lock is exercisable.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const src = fs.readFileSync(
  path.join(import.meta.dirname, "main.js"),
  "utf8"
);
(0, eval)(src);
const wl = globalThis.window.dhanWL;

assert.strictEqual(wl.segOf("NSE", "E"), 1);
assert.strictEqual(wl.segOf("NSE", "M"), 10);
assert.strictEqual(wl.segOf("BSE", "E"), 4);
assert.strictEqual(wl.segOf("BSE", "D"), 8);
assert.strictEqual(wl.segOf("MCX", "M"), 5);
assert.strictEqual(wl.segOf("NCDEX", "M"), 6);
assert.strictEqual(wl.segOf("IDX", "E"), 0, "IDX ignores the segment letter");
assert.strictEqual(
  wl.segOf("IDX", ""),
  -1,
  "bundle's T() rejects a falsy segment before its IDX shortcut"
);
assert.strictEqual(wl.segOf("NSE", ""), -1);
assert.strictEqual(wl.segOf("NSE", undefined), -1);
assert.strictEqual(wl.segOf("NSE", "I"), 0, "seg 0 must survive the lookup, not fall to -1");
assert.strictEqual(wl.segOf("MCX", "E"), -1);
assert.strictEqual(wl.segOf("NOPE", "E"), -1);

assert.deepStrictEqual(
  wl.findMissing(["AAA", "BBB", "CCC"], [
    { display_name: "aaa" },
    { display_name: " CCC " },
  ]),
  ["BBB"],
  "findMissing: case- and space-insensitive, reports only the absent"
);
assert.deepStrictEqual(
  wl.findMissing(["AAA"], [{ display_name: "Alpha Ltd", symbol: "AAA" }]),
  [],
  "matches on any string field, not just display_name"
);
assert.deepStrictEqual(
  wl.findMissing(["AAA"], [{ security_id: 42, display_name: "Alpha Ltd" }]),
  ["AAA"],
  "non-string fields do not blow up the scan"
);
assert.deepStrictEqual(wl.findMissing(["AAA"], []), ["AAA"]);
assert.deepStrictEqual(wl.findMissing([], [{ display_name: "AAA" }]), []);

assert.strictEqual(wl.queryFromTvSymbol("NSE:RELIANCE"), "RELIANCE");
assert.strictEqual(
  wl.queryFromTvSymbol("NSEE1234:PARAG MILK FOODS"),
  "PARAG MILK FOODS",
  "a company name must survive whole - splitting it 404s on screener.in"
);
assert.strictEqual(wl.queryFromTvSymbol("nse:aeroplane"), "AEROPLANE");
assert.strictEqual(
  wl.queryFromTvSymbol("NSEE1:  TATA   MOTORS  "),
  "TATA MOTORS",
  "runs of whitespace collapse to single spaces"
);
assert.strictEqual(wl.queryFromTvSymbol("M&M"), "M&M", "ampersand survives");
assert.strictEqual(wl.queryFromTvSymbol(""), "");
assert.strictEqual(wl.queryFromTvSymbol(null), "");

assert.strictEqual(KEY.length, 16, "keySize 4 words = 128-bit");
assert.strictEqual(decrypt(encrypt('{"a":1}')), '{"a":1}');
assert.strictEqual(
  encrypt('{"client_id":"X"}').slice(0, 12),
  encrypt('{"client_id":"X"}').slice(0, 12),
  "fixed IV means a fixed plaintext prefix yields a fixed ciphertext prefix"
);

// Exercise the actual worker and isolated bridge, including a missing receiver.
let receive;
let fetches = 0;
const panelOpens = [];
const panelOptions = [];
let tabUpdated;
let runCommand;
const delivered = [];
vm.runInNewContext(fs.readFileSync(new URL("background.js", import.meta.url), "utf8"), {
  chrome: {
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(fn) { receive = fn; } }, sendMessage(payload, cb) { if (payload && payload.type === "panelCommand") delivered.push(payload); if (cb) cb({ ok: true }); return Promise.resolve(); } },
    sidePanel: { setPanelBehavior() { return Promise.resolve(); }, setOptions: async (o) => { panelOptions.push(o); }, open: async (o) => { panelOpens.push(o); } },
    tabs: { onUpdated: { addListener(fn) { tabUpdated = fn; } }, sendMessage: (tabId, msg, cb) => cb(msg.type === "chartSymbol" ? { symbol: "NSEE1660:ITC", name: "ITC" } : {}) },
    commands: { onCommand: { addListener(fn) { runCommand = fn; } } },
    storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  },
  fetch: async () => {
    fetches++;
    return { ok: true, json: async () => [{ name: "Reliance", url: "/company/RELIANCE/" }], text: async () => "<html id='company-page'>Market Cap ₹ 17,38,728 Cr.</html>" };
  },
});
const result = await new Promise(resolve => {
  assert.equal(receive({ type: "screener", symbol: "RELIANCE" }, {}, resolve), true);
});
assert.equal(result.url, "https://www.screener.in/company/RELIANCE/");
assert.equal(fetches, 1, "company resolution uses one search request");
const page = await new Promise(resolve => receive({ type: "screener", symbol: "RELIANCE", page: true }, { tab: { id: 7 } }, resolve));
assert.equal(page.url, "https://www.screener.in/company/RELIANCE/");
assert.match(page.html, /Market Cap/);
assert.equal(fetches, 3, "page mode searches then fetches the public company HTML");
const invalid = await new Promise(resolve => receive({ type: "screener", symbol: "../bad" }, {}, resolve));
assert.match(invalid.error, /malformed/);
assert.equal(fetches, 3);
let relay;
let reply;
const fakeWindow = {
  location: { origin: "https://tv.dhan.co" },
  addEventListener(type, fn) { relay = fn; },
  postMessage(msg) { reply = msg; },
};
const runtime = {
  id: "test",
  sendMessage(msg, callback) { callback(result); },
  onMessage: { addListener() {} },
};
const pageEvents = {};
vm.runInNewContext(fs.readFileSync(new URL("bridge.js", import.meta.url), "utf8"), {
  window: fakeWindow,
  chrome: { runtime },
  document: {
    addEventListener(type, fn) { pageEvents[type] = fn; },
    removeEventListener(type) { delete pageEvents[type]; },
  },
});
const request = { source: fakeWindow, data: { __dhanWL: "request", id: 1, symbol: "RELIANCE" } };
relay(request);
assert.equal(reply.url, result.url);
runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
relay(request);
assert.match(reply.error, /Reload the extension/);
delete runtime.lastError;
relay(request);
assert.equal(reply.url, result.url, "retry can recover once the worker is available");
delete runtime.id;
relay(request);
assert.match(reply.error, /refresh the page/);

// The page's first gesture asks the worker to open the panel, exactly once.
let opens = 0;
runtime.id = "test"; // the orphan case above cleared it
runtime.sendMessage = (msg, callback) => { if (msg.type === "openPanel") opens += 1; if (callback) callback(); };
pageEvents.pointerdown();
pageEvents.pointerdown?.();
assert.equal(opens, 1, "the panel is asked for once per page, not on every click");


// A shortcut on a Dhan tab resolves what is charted and hands the panel a verb.
await runCommand("flag-red", { id: 7, url: "https://tv.dhan.co/charts" });
assert.deepEqual(delivered, [{ type: "panelCommand", command: "flag-red", symbol: "NSEE1660:ITC", name: "ITC", tabId: 7 }]);
await runCommand("flag-red", { id: 9, url: "https://example.com/" });
assert.equal(delivered.length, 1, "shortcuts do nothing off tv.dhan.co");
await runCommand("some-other-command", { id: 7, url: "https://tv.dhan.co/charts" });
assert.equal(delivered.length, 1, "an unknown command is ignored");

const rules = JSON.parse(fs.readFileSync(new URL("screener-rules.json", import.meta.url)));
assert.deepEqual(rules[0].condition.initiatorDomains, ["tv.dhan.co"]);
assert.deepEqual(rules[0].condition.resourceTypes, ["sub_frame"]);
assert.match(rules[0].action.responseHeaders[1].value, /object-src 'none'/);
assert.match(rules[0].action.responseHeaders[1].value, /frame-ancestors 'self' https:\/\/tv\.dhan\.co/);

// Sidepanel pure-model regression checks (no browser or DOM dependency).
const panelWindow = {};
vm.runInNewContext(fs.readFileSync(new URL("sidepanel.js", import.meta.url), "utf8"), {
  window: panelWindow,
  localStorage: { getItem: () => null, setItem() {} },
  console,
});
const panel = panelWindow.tradebaba;
assert.deepEqual(
  ["x", "100", "120", "110", "110", "-", "130", "140"].map((value, i, values) =>
    panel.compare({ headers: ["Metric", "Jan 2024", "Feb 2024", "Mar 2024", "Apr 2024", "May 2024", "Jun 2024", "Jul 2024"], values }, i, { enabled: true })
  ),
  ["", "", "up", "down", "", "", "", "up"],
  "adjacent comparison leaves first, flat, and missing predecessors neutral"
);
const share = (values, invert = false) => values.map((value, i) => panel.compare({ headers: ["Holding", "Jan 2024", "Feb 2024", "Mar 2024"], values }, i, { enabled: true, invert }));
assert.deepEqual(share(["FIIs", "10", "12", "11"]), ["", "", "up", "down"]);
assert.deepEqual(share(["Public", "10", "12", "11"], true), ["", "", "down", "up"]);
assert.strictEqual(panel.number("₹ 1,23,456"), 123456);
assert.strictEqual(panel.number("(−1,200)%"), -1200);
assert.strictEqual(panel.number("N/A"), null);
assert.deepEqual(panel.defaults().lists[0].items.map((x) => x.symbol), ["NSEE2885:RELIANCE", "NSEE11536:TCS", "NSEE1594:INFY", "NSEE1333:HDFCBANK"]);

// Panel symbol search: only NSE equity hits that carry a real security id and a
// chart-legal ticker may become a chart symbol; nothing is synthesized.
assert.deepEqual(
  wl.chartSymbolFromHit({ exchange: "NSE", segment: "E", security_id: 2885, symbol: "RELIANCE", display_name: "Reliance Industries Ltd" }),
  { symbol: "NSEE2885:RELIANCE", name: "Reliance Industries Ltd" }
);
assert.deepEqual(
  wl.chartSymbolFromHit({ exchange: "NSE", segment: "E", security_id: "1594", display_name: "INFY" }),
  { symbol: "NSEE1594:INFY", name: "INFY" },
  "falls back to display_name when the hit carries no ticker field"
);
assert.strictEqual(wl.chartSymbolFromHit({ exchange: "BSE", segment: "E", security_id: 1, symbol: "X" }), null);
assert.strictEqual(wl.chartSymbolFromHit({ exchange: "NSE", segment: "D", security_id: 1, symbol: "X" }), null);
assert.strictEqual(wl.chartSymbolFromHit({ exchange: "NSE", segment: "E", symbol: "X" }), null, "no security id, no symbol");
assert.strictEqual(wl.chartSymbolFromHit({ exchange: "NSE", segment: "E", security_id: "12a", symbol: "X" }), null);
assert.strictEqual(wl.chartSymbolFromHit({ exchange: "NSE", segment: "E", security_id: 5, symbol: "BAD/TICKER" }), null);
assert.strictEqual(wl.chartSymbolFromHit(null), null);

// Datafeed search rows: take the chart symbol the feed already knows, and drop
// a row whose ticker is not a symbol setSymbol would accept.
assert.deepEqual(
  wl.chartSymbolFromSearch({ ticker: "NSEE1660:ITC", description: "ITC Ltd", exchange: "NSE" }),
  { symbol: "NSEE1660:ITC", name: "ITC Ltd" }
);
assert.deepEqual(
  wl.chartSymbolFromSearch({ full_name: "NSEE7229:HAL" }),
  { symbol: "NSEE7229:HAL", name: "HAL" },
  "falls back to full_name, then to the ticker half for the label"
);
assert.strictEqual(wl.chartSymbolFromSearch({ ticker: "BSE:500325", description: "x" }), null);
assert.strictEqual(wl.chartSymbolFromSearch(null), null);


// Opening on tv.dhan.co: the panel is offered on Dhan tabs only, and a page
// gesture asks the worker to open it.
tabUpdated(7, { status: "complete" }, { url: "https://tv.dhan.co/charts" });
tabUpdated(8, { status: "complete" }, { url: "https://example.com/" });
await new Promise((r) => setTimeout(r, 0));
assert.deepEqual(panelOptions, [
  { tabId: 7, path: "sidepanel.html", enabled: true },
  { tabId: 8, path: "sidepanel.html", enabled: false },
], "the side panel is this tab's panel on Dhan and disabled everywhere else");
const opensBefore = panelOpens.length;
receive({ type: "openPanel" }, { tab: { id: 7 } }, () => {});
await new Promise((r) => setTimeout(r, 0));
assert.equal(panelOpens.length, opensBefore + 1, "a page gesture opens the panel once");
assert.deepEqual(panelOpens.at(-1), { tabId: 7 }, "and opens it for that tab");

console.log("logic + crypto self-consistency: ok");

// --- decisive check: decrypt captured traffic ---
const har = process.argv[2];
if (!har) {
  console.log("no HAR given - skipping the live-traffic check");
  process.exit(0);
}
const log = JSON.parse(fs.readFileSync(har, "utf8")).log;
let checked = 0;
for (const entry of log.entries) {
  if (!entry.request.url.includes("/watchlist/")) continue;
  const name = entry.request.url.split("/").pop();

  const sent = entry.request.postData?.text;
  if (sent) {
    const cipher = JSON.parse(decodeURIComponent(JSON.parse(sent)));
    console.log(`  ${name} request  ->`, decrypt(cipher).slice(0, 200));
    checked++;
  }
  const body = entry.response.content?.text;
  if (body) {
    const plain = decrypt(JSON.parse(body).data);
    JSON.parse(plain); // throws if the key is wrong
    console.log(`  ${name} response ->`, plain.slice(0, 200));
    checked++;
  }
}
assert.ok(checked > 0, "HAR contained no /watchlist/ bodies");
console.log(`live-traffic check: ok (${checked} bodies decrypted)`);
