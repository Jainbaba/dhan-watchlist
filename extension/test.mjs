// node test.mjs            -> pure logic + crypto self-consistency
// node test.mjs /tmp/dhan.har -> also decrypts real captured traffic (decisive)
import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
globalThis.window = {};
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

assert.strictEqual(wl.describeWindow(182), "6-month");
assert.strictEqual(wl.describeWindow(365), "12-month");
assert.strictEqual(wl.describeWindow(undefined), "published");

assert.strictEqual(wl.claimSyncLock(), true, "first claim wins");
assert.strictEqual(wl.claimSyncLock(), false, "second tab is locked out");
wl.releaseSyncLock();
assert.strictEqual(wl.claimSyncLock(), true, "claimable again once released");
wl.releaseSyncLock();
store.set("dhanWL:syncLock", String(Date.now() - 5 * 60 * 1000));
assert.strictEqual(wl.claimSyncLock(), true, "a stale lock does not wedge forever");
wl.releaseSyncLock();

assert.strictEqual(KEY.length, 16, "keySize 4 words = 128-bit");
assert.strictEqual(decrypt(encrypt('{"a":1}')), '{"a":1}');
assert.strictEqual(
  encrypt('{"client_id":"X"}').slice(0, 12),
  encrypt('{"client_id":"X"}').slice(0, 12),
  "fixed IV means a fixed plaintext prefix yields a fixed ciphertext prefix"
);

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
