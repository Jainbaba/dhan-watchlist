(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const LIST_KEY = "tradebaba:watchlists:v1", THEME_KEY = "tradebaba:theme", METRIC_KEY = "tradebaba:metric-colors", WIDTH_KEY = "tradebaba:rail-width", GITHUB_KEY = "tradebaba:github", AUTO_KEY = "tradebaba:autoOpen";
  const sampleStocks = [{ name: "Reliance Industries", symbol: "NSEE2885:RELIANCE" }, { name: "Tata Consultancy Services", symbol: "NSEE11536:TCS" }, { name: "Infosys", symbol: "NSEE1594:INFY" }, { name: "HDFC Bank", symbol: "NSEE1333:HDFCBANK" }];
  // A flag is a classification, not a verdict: the Red list is "things I marked
  // red", never "things that fell". One colour per symbol, held globally, so
  // deleting a regular list never drops a flag.
  const FLAGS = [["red", "Red", "#e53935"], ["orange", "Orange", "#fb8c00"], ["yellow", "Yellow", "#f9a825"], ["green", "Green", "#43a047"], ["blue", "Blue", "#1e88e5"]];
  const FLAG_COLOR = Object.fromEntries(FLAGS.map(([key, , hex]) => [key, hex]));
  const FLAG_LABEL = Object.fromEntries(FLAGS.map(([key, label]) => [key, label]));
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const number = (value) => { let s = clean(value).replace(/[₹$€£,%]/g, "").replace(/,/g, "").trim(); const wrapped = /^\(.*\)$/.test(s); if (wrapped) s = s.slice(1, -1); s = s.replace(/[−–]/g, "-").trim(); if (wrapped && !s.startsWith("-")) s = `-${s}`; return s && /^[-+]?\d*(?:\.\d+)?$/.test(s) && s !== "-" && s !== "." ? Number(s) : null; };
  const period = (s) => { const m = clean(s).match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{4})$/i); return m ? Date.UTC(Number(m[2]), ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(m[1].slice(0, 3).toLowerCase()), 1) : null; };
  function compare(row, index, setting = {}) { if (!setting.enabled || index < 2 || !period(row.headers?.[index])) return ""; const a = number(row.values?.[index - 1]), b = number(row.values?.[index]); if (a === null || b === null || a === b) return ""; const up = b > a; return (setting.invert ? !up : up) ? "up" : "down"; }
  function defaults() { return { lists: [{ id: "default", name: "My Watchlist", items: sampleStocks.map((x) => ({ ...x, exchange: "NSE" })), favorite: true }], instruments: {}, flags: {}, notes: {}, activeListId: "default", recentListIds: [], view: "standard", sort: null }; }
  function loadModel() { try { const x = JSON.parse(localStorage.getItem(LIST_KEY)); if (x && Array.isArray(x.lists) && x.lists.length) { if (!x.flags || typeof x.flags !== "object") x.flags = {}; if (!x.instruments || typeof x.instruments !== "object") x.instruments = {}; if (!x.sort || typeof x.sort !== "object" || !["symbol", "last", "change", "changePercent"].includes(x.sort.key)) x.sort = null; return x; } } catch (_) {} return defaults(); }
  function saveModel(model) { model.updatedAt = Date.now(); try { localStorage.setItem(LIST_KEY, JSON.stringify(model)); } catch (_) { showStatus("Changes could not be saved", true); return false; } backup(model); return true; }
  // Backup/sync ride on chrome.storage.sync: it is the browser's own account
  // sync, so no OAuth, no server, and it survives clearing site data. Quota is
  // ~100KB, and Brave keeps it on-device -- report a rejected write instead of
  // pretending it landed. Debounced, because every rename would otherwise burn
  // one of the 120-writes-per-minute allowance.
  let backupTimer = null;
  let gistTimer = null, lastBackup = null;
  function backup(model) { clearTimeout(backupTimer); backupTimer = setTimeout(() => { chrome?.storage?.sync?.set({ [LIST_KEY]: model }).catch((e) => showStatus(`Cloud backup failed: ${e.message}`, true)); }, 1500); pushGist(model); }
  // Longer debounce than the local copy: a rename should cost one gist
  // revision, not one per keystroke. Silent when no token is configured.
  function pushGist(model) { clearTimeout(gistTimer); gistTimer = setTimeout(async () => { try { const config = (await chrome.storage.local.get(GITHUB_KEY))[GITHUB_KEY]; if (!config?.token) return; const res = await chrome.runtime.sendMessage({ type: "backupPush", model }); if (res?.error) throw new Error(res.error); lastBackup = res; } catch (e) { showStatus(`GitHub backup failed: ${e.message}`, true); } }, 5000); }
  // A backup only helps if it comes back: adopt the stored copy when it is
  // newer than this device's, never when it is older or the same.
  const SNAPSHOT_KEY = "tradebaba:watchlists:previous";
  // Anything that replaces the whole model keeps what it replaced, so a wrong
  // restore is one click from being undone rather than gone.
  function snapshot() { try { const now = localStorage.getItem(LIST_KEY); localStorage.setItem(SNAPSHOT_KEY, now || JSON.stringify(model)); } catch (_) {} }
  function undoReplace() { try { const previous = localStorage.getItem(SNAPSHOT_KEY); if (!previous) return false; const restored = JSON.parse(previous); if (!restored || !Array.isArray(restored.lists) || !restored.lists.length) return false; snapshot(); model = restored; localStorage.setItem(LIST_KEY, previous); renderWatchlist(); return true; } catch (_) { return false; } }
  // Adopting a newer sync copy automatically is how a watchlist changes under
  // you with no way back. Report it and let the Settings button decide.
  async function syncedBackup() { if (!chrome?.storage?.sync) return null; try { const stored = (await chrome.storage.sync.get(LIST_KEY))[LIST_KEY]; if (!stored || !Array.isArray(stored.lists) || !stored.lists.length) return null; return stored; } catch (_) { return null; } }
  function adopt(next) { if (!next || !Array.isArray(next.lists) || !next.lists.length) return false; snapshot(); model = next; if (!model.flags || typeof model.flags !== "object") model.flags = {}; if (!model.instruments || typeof model.instruments !== "object") model.instruments = {}; try { localStorage.setItem(LIST_KEY, JSON.stringify(model)); } catch (_) { return false; } renderWatchlist(); return true; }
  function metricPrefs() { try { const x = JSON.parse(localStorage.getItem(METRIC_KEY)); return x && typeof x === "object" ? x : {}; } catch (_) { return {}; } }
  function saveMetrics(x) { try { localStorage.setItem(METRIC_KEY, JSON.stringify(x)); } catch (_) { showStatus("Changes could not be saved", true); } }
  function showStatus(text, error = false) { const s = $("status"); if (s) { s.hidden = false; s.textContent = text; s.className = error ? "error" : ""; } }
  // Long jobs need a visible sign they are running: the status line pins itself
  // to the top of the pane and spins until the caller says it is done.
  function busy(text) { const s = $("status"); showStatus(text); s.classList.add("working"); return (done, error = false) => { s.classList.remove("working"); if (done != null) showStatus(done, error); }; }
  function node(tag, value, cls) { const n = document.createElement(tag); if (value != null) n.textContent = value; if (cls) n.className = cls; return n; }
  function parse(html) { const doc = new DOMParser().parseFromString(html, "text/html"), text = (x) => clean(x?.textContent); const rows = (selector) => { const t = doc.querySelector(`${selector} table.data-table`); return t ? [...t.querySelectorAll("tr")].map((tr) => [...tr.children].map(text)).filter((r) => r.length) : []; }; const lists = (selector) => [...doc.querySelectorAll(`${selector} li`)].map(text).filter(Boolean); return { doc, ratios: new Map([...doc.querySelectorAll("#top-ratios li")].map((li) => [text(li.querySelector(".name")), text(li.querySelector(".value"))])), quarters: rows("#quarters"), profit: rows("#profit-loss"), pros: lists("#analysis .pros"), cons: lists("#analysis .cons"), shareholding: rows("#shareholding"), growth: [...doc.querySelectorAll("#profit-loss table.ranges-table")].map((t) => [...t.querySelectorAll("tr")].map((tr) => [...tr.children].map(text)).filter((r) => r.length)) }; }
  function settingFor(sectionId, label) { const p = metricPrefs(), key = `${sectionId}:${clean(label)}`; return p[key] || (sectionId === "shareholding" && /^(FIIs?|DIIs?|Promoters?|Public)$/i.test(clean(label)) ? { enabled: true, invert: /^(Promoters?|Public)$/i.test(clean(label)) } : { enabled: false, invert: false }); }
  function table(rows, sectionId) { const wrap = document.createElement("div"); wrap.className = "table-scroll"; const t = document.createElement("table"); if (!rows.length) { wrap.append(t); return wrap; } const rawHeaders = rows[0]; const order = rawHeaders.slice(1).map((h, i) => ({ i: i + 1, t: period(h) })).filter((x) => x.t !== null); const descending = order.length > 1 && order.every((x, i) => i === 0 || x.t <= order[i - 1].t); const columns = descending ? order.sort((a, b) => a.t - b.t).map((x) => x.i) : rawHeaders.slice(1).map((_, i) => i + 1); const headers = [rawHeaders[0], ...columns.map((i) => rawHeaders[i])]; const normalizedRows = rows.map((r) => [r[0], ...columns.map((i) => r[i] ?? "")]); normalizedRows.forEach((r, ri) => { const tr = document.createElement("tr"); r.forEach((v, ci) => { const c = node(ri ? "td" : "th", v); c.scope = ri ? (ci ? "col" : "row") : "col"; if (ci === 0) c.className = "sticky-label"; if (ri && ci > 0 && sectionId) { const cls = compare({ headers, values: r }, ci, settingFor(sectionId, r[0])); if (cls) { c.classList.add(`metric-${cls}`); c.title = `${headers[ci]}: ${cls === "up" ? "increased" : "decreased"} from ${headers[ci - 1]}`; c.setAttribute("aria-label", `${v}, ${c.title}`); } } tr.append(c); }); t.append(tr); }); wrap.append(t); requestAnimationFrame(() => { wrap.scrollLeft = wrap.scrollWidth; }); return wrap; }
  let activeTab = null, current = null, sequence = 0, searchSequence = 0, model = loadModel();
  const symbolsOf = (list) => (list.items || []).filter((x) => x && x.symbol);
  function knownInstruments() { const seen = new Map(Object.entries(model.instruments || {})); model.lists.forEach((l) => symbolsOf(l).forEach((x) => seen.set(x.symbol, x))); return seen; }
  function flagged(color) { const known = knownInstruments(); return Object.keys(model.flags || {}).filter((s) => model.flags[s] === color).map((s) => known.get(s)).filter(Boolean); }
  function flagList(color) { return { id: `flag:${color}`, name: `${FLAG_LABEL[color]} list`, items: flagged(color), flag: color }; }
  function activeList() { const id = String(model.activeListId || ""); if (id.startsWith("flag:") && FLAG_COLOR[id.slice(5)]) return flagList(id.slice(5)); const a = model.lists.find((x) => x.id === id) || model.lists[0]; model.activeListId = a.id; return a; }
  let pickerOpen = false;
  const refocusHead = () => $("stocks").querySelector(".list-button")?.focus();
  // Destructive answers stay in the panel rather than in a window dialog: same
  // confirmation, no modal, and Cancel never mutates.
  function askInline(host, message, label, onYes) { const bar = node("div", null, "confirm-bar"); const yes = node("button", label); const no = node("button", "Cancel"); yes.onclick = onYes; no.onclick = () => { bar.remove(); refocusHead(); }; bar.onkeydown = (e) => { if (e.key === "Escape") { bar.remove(); refocusHead(); } }; bar.append(node("span", message), yes, no); host.append(bar); yes.focus(); }
  // Enter or blur commits, Escape cancels, and whichever lands first wins -- the
  // blur that Escape itself causes must not re-commit the abandoned text.
  function nameEditor(value, commit, cancel) { let settled = false; const input = document.createElement("input"); input.className = "inline-input"; input.value = value; input.setAttribute("aria-label", "Name"); const finish = (fn, text) => { if (settled) return; settled = true; fn(text); }; input.onkeydown = (e) => { if (e.key !== "Enter" && e.key !== "Escape") return; e.preventDefault(); e.stopPropagation(); finish(e.key === "Enter" ? commit : cancel, clean(input.value)); }; input.onblur = () => finish(commit, clean(input.value)); return input; }
  function editInPlace(target, value, apply) { const input = nameEditor(value, (name) => { if (name) apply(name.slice(0, 60)); renderWatchlist(); }, () => renderWatchlist()); target.replaceWith(input); input.focus(); input.select(); }
  function listPicker(active) { const panel = node("div", null, "list-picker"); const create = node("button", "+  New list", "picker-new"); create.onclick = () => editInPlace(create, "New Watchlist", (name) => { model.lists.push({ id: `list-${Date.now()}`, name, items: [], favorite: false }); model.activeListId = model.lists.at(-1).id; saveModel(model); }); panel.append(create, node("p", "Watchlists", "muted")); model.lists.forEach((list) => { const row = node("div", null, list.id === active.id ? "picker-row on" : "picker-row"); const pick = node("button", null, "picker-name"); pick.append(node("span", list.name), node("small", String(symbolsOf(list).length))); pick.onclick = () => { model.activeListId = list.id; pickerOpen = false; saveModel(model); renderWatchlist(); refocusHead(); }; const rename = node("button", "✎", "picker-act"); rename.title = `Rename ${list.name}`; rename.onclick = () => editInPlace(pick, list.name, (name) => { list.name = name; saveModel(model); }); const drop = node("button", "×", "picker-act"); drop.title = `Delete ${list.name}`; drop.disabled = model.lists.length < 2; drop.onclick = () => askInline(row, `Delete ${list.name}? Colour flags are kept.`, "Delete", () => { model.lists = model.lists.filter((l) => l.id !== list.id); if (model.activeListId === list.id) model.activeListId = model.lists[0].id; saveModel(model); renderWatchlist(); refocusHead(); }); row.append(pick, rename, drop); panel.append(row); }); panel.append(node("p", "Colour lists", "muted")); FLAGS.forEach(([key, label, hex]) => { const id = `flag:${key}`; const row = node("div", null, active.id === id ? "picker-row on" : "picker-row"); const pick = node("button", null, "picker-name"); const dot = node("span", null, "row-flag"); dot.style.background = hex; pick.append(dot, node("span", `${label} list`), node("small", String(flagged(key).length))); pick.onclick = () => { model.activeListId = id; pickerOpen = false; saveModel(model); renderWatchlist(); refocusHead(); }; row.append(pick); panel.append(row); }); panel.onkeydown = (e) => { if (e.key === "Escape") { pickerOpen = false; renderWatchlist(); refocusHead(); } }; return panel; }
  function listHead(active) { const head = node("div", null, "list-head"); const toggle = node("button", null, "list-button"); toggle.setAttribute("aria-expanded", String(pickerOpen)); if (active.flag) { const dot = node("span", null, "row-flag"); dot.style.background = FLAG_COLOR[active.flag]; toggle.append(dot); } toggle.append(node("span", active.name), node("small", String(symbolsOf(active).length)), node("span", "▾", "caret")); toggle.onclick = () => { pickerOpen = !pickerOpen; renderWatchlist(); refocusHead(); }; const tools = node("div", null, "list-tools"); const act = (label, hint, fn) => { const b = node("button", label); b.title = hint; b.onclick = fn; return b; }; const bulk = act("Bulk", "Add many symbols at once", () => { const open = document.querySelector(".bulk-form"); if (open) { open.remove(); return; } const form = bulkForm(active, () => document.querySelector(".bulk-form")?.remove()); head.after(form); form.querySelector("textarea").focus(); }); bulk.disabled = Boolean(active.flag); const push = act("To Dhan", `Replace the Dhan watchlist named "${active.name}" with these symbols`, async () => { const symbols = symbolsOf(active); if (!symbols.length) { showStatus("Nothing to push - this list is empty", true); return; } if (symbols.length > 250) { showStatus(`Dhan holds 250 symbols per watchlist; this list has ${symbols.length}`, true); return; } if (activeTab == null) { showStatus("Open a Dhan chart tab first", true); return; } if (!confirm(`Replace the Dhan watchlist "${active.name}" with these ${symbols.length} symbols? Whatever it holds now is removed.`)) return; const stop = busy(`Pushing ${symbols.length} symbols to Dhan\u2026`); push.disabled = true; try { const res = await chrome.runtime.sendMessage({ type: "pushWatchlist", tabId: activeTab, name: active.name, names: symbols.map((x) => x.symbol.split(":").at(-1)) }); if (res?.error) throw new Error(res.error);
      // Say what did not make it, not just how many: "50 of 53" on its own
      // leaves you hunting for the three.
      const gaps = []; if (res.missing?.length) gaps.push(`Dhan found no match for: ${res.missing.join(", ")}`); if (res.unmapped) gaps.push(`${res.unmapped} on a segment TradeBaba does not map`); const dropped = res.requested - res.pushed; if (dropped > 0 && !gaps.length) gaps.push(`${dropped} resolved to a duplicate or below the confidence bar`);
      stop(`Pushed ${res.pushed} of ${res.requested} to Dhan's "${res.watchlist}"${gaps.length ? `. ${gaps.join(". ")}` : ""}`, dropped > 0); } catch (e) { stop(e.message, true); } finally { push.disabled = false; } });
    const clear = act("Clear", active.flag ? "Unflag every symbol in this colour list" : "Remove every symbol from this watchlist", () => { if (!confirm(active.flag ? `Unflag every symbol in the ${active.name}?` : `Clear ${active.name}? Every symbol is removed.`)) return; if (active.flag) active.items.forEach((x) => delete model.flags[x.symbol]); else active.items = []; saveModel(model); renderWatchlist(); refocusHead(); }); const section = act("Section", "Add a section divider to this watchlist", () => { const input = nameEditor("New section", (name) => { if (name) { active.items.push({ id: `sec-${Date.now()}`, section: name.slice(0, 60), collapsed: false }); saveModel(model); } renderWatchlist(); }, () => renderWatchlist()); section.replaceWith(input); input.focus(); input.select(); }); section.disabled = Boolean(active.flag); tools.append(section, bulk, push, clear); head.append(toggle, tools); return head; }
  function addStock(hit) { const list = activeList(); if (list.items.some((x) => x.symbol === hit.symbol)) { showStatus(`${hit.name} is already in ${list.name}`); return; } list.items.push({ name: hit.name, symbol: hit.symbol, exchange: "NSE" }); if (!saveModel(model)) return; renderWatchlist(); select(hit); }
  async function searchSymbols(query, results) { const token = ++searchSequence; results.hidden = false; results.replaceChildren(node("p", `Searching Dhan for “${query}”…`, "muted")); if (activeTab == null) { results.replaceChildren(node("p", "Open a Dhan chart tab to search symbols.", "error")); return; } try { const res = await chrome.runtime.sendMessage({ type: "searchSymbols", tabId: activeTab, query }); if (token !== searchSequence) return; if (res?.error) throw new Error(res.error); const hits = Array.isArray(res?.hits) ? res.hits : []; results.replaceChildren(); if (!hits.length) { results.append(node("p", `No NSE equity matching “${query}”.`, "muted")); return; } hits.forEach((hit) => { const button = node("button", null, "result-row"); button.type = "button"; button.append(node("strong", hit.symbol.split(":").at(-1)), node("small", hit.name)); button.onclick = () => addStock(hit); results.append(button); }); } catch (e) { if (token === searchSequence) results.replaceChildren(node("p", e.message, "error")); } }
  const quoteCells = new Map(), quoteData = new Map(); let quoteTimer = null, quoteSequence = 0, quoteNote = null;
  function noteQuotes(text) { if (!quoteNote) return; quoteNote.textContent = text; quoteNote.hidden = !text; }
  // A feed answers a fresh subscription with a partial quote - a price and no
  // change, or nothing at all - so a repaint must MERGE onto what is already
  // known. Overwriting was why prices blinked out and came back while scrolling.
  function paintQuote(symbol, incoming) { const known = quoteData.get(symbol) || {}; const pick = (a, b) => (Number.isFinite(a) ? a : Number.isFinite(b) ? b : null); const quote = { last: pick(incoming?.last, known.last), change: pick(incoming?.change, known.change), changePercent: pick(incoming?.changePercent, known.changePercent) }; if (quote.last === null && quote.change === null && quote.changePercent === null) return; quoteData.set(symbol, quote); const cells = quoteCells.get(symbol); if (!cells) return; const money = (v) => (Number.isFinite(v) ? v.toFixed(2) : "—"); cells.last.textContent = money(quote?.last); const change = quote?.change, percent = quote?.changePercent; cells.change.textContent = Number.isFinite(change) ? `${change > 0 ? "+" : ""}${money(change)} (${Number.isFinite(percent) ? `${percent > 0 ? "+" : ""}${percent.toFixed(2)}` : "—"}%)` : "—"; cells.change.className = `q-change${Number.isFinite(change) && change !== 0 ? (change > 0 ? " metric-up" : " metric-down") : ""}`; }
  // Poll only while the panel shows rows, and stop the loop the moment the page
  // says it has no feed -- an unavailable column is honest, a retry storm is not.
  // NSE trades 09:15-15:30 IST, Monday to Friday. Outside that the poll has
  // nothing to learn, so it stops rather than waking every ten seconds all
  // night; the same goes for a panel you cannot see.
  function marketOpen(at = new Date()) {
    const ist = new Date(at.getTime() + (at.getTimezoneOffset() + 330) * 60000);
    const day = ist.getDay();
    if (day === 0 || day === 6) return false;
    const minutes = ist.getHours() * 60 + ist.getMinutes();
    return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
  }
  const panelVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  let streaming = false, quoteTries = 0;
  // The panel usually opens before the chart page has built its datafeed, so a
  // first failure means "not ready yet", not "never". Retry a few times before
  // settling on the error, which is why prices used to appear only after a
  // click forced a redraw.
  async function refreshQuotes(symbols, retry = 0) { clearTimeout(quoteTimer); const token = ++quoteSequence; if (!symbols.length || activeTab == null) return; if (streaming && watchKey(symbols) === watching) return; try { const res = await chrome.runtime.sendMessage({ type: "getQuotes", tabId: activeTab, symbols }); if (token !== quoteSequence) return; if (res?.error) { if (retry < 5) { quoteTimer = setTimeout(() => refreshQuotes(symbols, retry + 1), 2000); return; } return noteQuotes(res.error); } noteQuotes(""); (Array.isArray(res?.quotes) ? res.quotes : []).forEach((q) => paintQuote(q.symbol, q)); if (!streaming && marketOpen() && panelVisible()) quoteTimer = setTimeout(() => refreshQuotes(symbols), 10000); } catch (e) { if (token !== quoteSequence) return; if (retry < 5) { quoteTimer = setTimeout(() => refreshQuotes(symbols, retry + 1), 2000); return; } noteQuotes(e.message); } }
  // Live ticks when the page's datafeed streams them; the 10s poll above is the
  // fallback, and only one of the two ever runs.
    // Order-insensitive on purpose: sorting reorders the rows but watches the same
  // symbols, and a needless resubscribe repaints from the feed's first partial
  // quote, which arrives as zeros.
  const watchKey = (symbols) => [...symbols].sort().join(",");
  let watching = "";
  async function watchQuotes(symbols) { if (activeTab == null) return; const key = watchKey(symbols); if (streaming && key === watching) return; watching = key; try { const res = await chrome.runtime.sendMessage({ type: "watchQuotes", tabId: activeTab, symbols }); streaming = Boolean(res?.streaming); } catch (_) { streaming = false; } }
  function rowMenu(stock, active, close) { const menu = node("div", null, "row-menu"); const swatches = node("div", null, "flag-row"); const ticker = stock.symbol.split(":").at(-1); FLAGS.forEach(([key, label, hex]) => { const b = node("button", null, model.flags[stock.symbol] === key ? "swatch on" : "swatch"); b.style.background = hex; b.title = `${label} list`; b.setAttribute("aria-label", `Flag ${ticker} ${label}`); b.onclick = () => { model.flags[stock.symbol] = key; model.instruments[stock.symbol] = { ...stock }; saveModel(model); renderWatchlist(); }; swatches.append(b); }); const none = node("button", "None", "swatch-none"); none.title = "Remove colour flag"; none.onclick = () => { delete model.flags[stock.symbol]; saveModel(model); renderWatchlist(); }; swatches.append(none); menu.append(node("p", "Colour", "muted"), swatches); const targets = model.lists.filter((l) => l.id !== active.id); if (targets.length) { menu.append(node("p", active.flag ? "Add to" : "Move to", "muted")); targets.forEach((target) => { const b = node("button", target.name); b.onclick = () => { if (!target.items.some((x) => x.symbol === stock.symbol)) target.items.push({ ...stock }); if (!active.flag) active.items = active.items.filter((x) => x.symbol !== stock.symbol); saveModel(model); renderWatchlist(); }; menu.append(b); }); } const sections = active.flag ? [] : (active.items || []).filter((x) => x && x.section != null); if (sections.length) { menu.append(node("p", "Move to section", "muted")); const place = (target) => { const items = active.items.filter((x) => x !== stock); items.splice(target ? items.indexOf(target) + 1 : 0, 0, stock); active.items = items; saveModel(model); renderWatchlist(); }; const top = node("button", "Top (no section)"); top.onclick = () => place(null); menu.append(top); sections.forEach((entry) => { const b = node("button", entry.section); b.onclick = () => place(entry); menu.append(b); }); } const drop = node("button", active.flag ? "Remove flag" : "Remove from list"); drop.onclick = () => { if (active.flag) delete model.flags[stock.symbol]; else active.items = active.items.filter((x) => x.symbol !== stock.symbol); saveModel(model); renderWatchlist(); }; menu.append(drop); menu.onkeydown = (e) => { if (e.key === "Escape") close(); }; return menu; }
  // A divider owns the symbols under it until the next divider. Removing it
  // keeps those symbols in the list -- only the grouping goes.
  function sectionRow(entry, active, movable) { const row = node("div", null, movable ? "section-row movable" : "section-row"); if (movable) dragRow(row, entry, active); const toggle = node("div", null, "section-name"); toggle.setAttribute("role", "button"); toggle.tabIndex = 0; toggle.setAttribute("aria-expanded", String(!entry.collapsed)); toggle.append(node("span", entry.collapsed ? "▸" : "▾", "caret"), node("span", entry.section)); toggle.onclick = () => { entry.collapsed = !entry.collapsed; saveModel(model); renderWatchlist(); }; toggle.onkeydown = (e) => { if (e.key !== "Enter") return; e.preventDefault(); toggle.onclick(); }; const rename = node("button", "✎", "picker-act"); rename.title = `Rename ${entry.section}`; rename.onclick = () => editInPlace(toggle, entry.section, (name) => { entry.section = name; saveModel(model); }); const drop = node("button", "×", "picker-act"); drop.title = "Remove divider"; drop.onclick = () => askInline(row, `Remove the ${entry.section} divider? Its symbols stay in the list.`, "Remove", () => { active.items = active.items.filter((x) => x !== entry); saveModel(model); renderWatchlist(); }); row.append(toggle, rename, drop); return row; }
  let dragging = null;
  function stockRow(stock, active, movable, quoted = true) { const holder = node("div", null, "row-holder"); const row = node("div", null, movable ? "stock-row movable" : "stock-row"); if (movable) dragRow(row, stock, active); const main = node("div", null, "row-main"); main.setAttribute("role", "button"); main.tabIndex = 0; main.dataset.symbol = stock.symbol; if (stock.symbol === charted) main.classList.add("charted"); const flag = model.flags[stock.symbol]; const dot = node("span", null, flag ? "row-flag" : "row-flag none"); if (flag) { dot.style.background = FLAG_COLOR[flag]; dot.title = `${FLAG_LABEL[flag]} list`; } const ticker = stock.symbol.split(":").at(-1); const last = node("span", "—", "q-last"), change = node("span", "—", "q-change"); if (quoted) { quoteCells.set(stock.symbol, { last, change }); if (quoteData.has(stock.symbol)) paintQuote(stock.symbol, quoteData.get(stock.symbol)); } main.append(dot, node("strong", ticker)); if (quoted) main.append(last); if (clean(stock.name).toUpperCase() !== ticker.toUpperCase()) main.append(node("small", stock.name)); if (quoted) main.append(change); main.onclick = () => select(stock, main); main.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); select(stock, main); return; } const step = e.altKey && e.key === "ArrowUp" ? -1 : e.altKey && e.key === "ArrowDown" ? 1 : 0; if (!step || !movable) return; e.preventDefault(); nudge(active, stock, step); }; const more = node("button", "⋯", "row-more"); more.type = "button"; more.title = "Symbol actions"; more.setAttribute("aria-expanded", "false"); const close = () => { holder.querySelector(".row-menu")?.remove(); more.setAttribute("aria-expanded", "false"); more.focus(); }; more.onclick = () => { if (holder.querySelector(".row-menu")) return close(); more.setAttribute("aria-expanded", "true"); holder.append(rowMenu(stock, active, close)); }; row.append(main, more); holder.append(row); return holder; }
  // Bulk add: the same paste-a-list contract the repo sync uses, plus its own
  // published list. Nothing is added until the resolve step has reported what
  // it could and could not map, and unresolved names stay on screen.
  function bulkForm(active, done) { const form = node("div", null, "bulk-form"); const box = document.createElement("textarea"); box.rows = 4; box.placeholder = "Paste symbols, one per line or comma separated"; box.setAttribute("aria-label", "Symbols to add in bulk"); const out = node("div", null, "bulk-out"); const buttons = node("div", null, "flag-row"); const resolve = node("button", "Resolve"); const published = node("button", "Load 20% below ATH"); published.title = "Fill this watchlist from the published NSE list of names within 20% of their all-time high"; const cancel = node("button", "Cancel"); cancel.onclick = done; const run = async (source) => { if (activeTab == null) { out.replaceChildren(node("p", "Open a Dhan chart tab to resolve symbols.", "error")); return; } const names = clean(box.value).split(/[\n,]+/).map(clean).filter(Boolean); if (!source && !names.length) { out.replaceChildren(node("p", "Paste at least one symbol.", "muted")); return; } out.replaceChildren(node("p", source ? "Fetching the published list, then resolving it with Dhan… this takes a few seconds for a long list." : `Resolving ${names.length} symbols…`, "muted")); resolve.disabled = published.disabled = true; try { const res = await chrome.runtime.sendMessage({ type: "bulkResolve", tabId: activeTab, names, source: source || "" }); if (res?.error) throw new Error(res.error); const hits = Array.isArray(res?.hits) ? res.hits : [], missing = Array.isArray(res?.missing) ? res.missing : []; const fresh = hits.filter((h) => !active.items.some((x) => x.symbol === h.symbol)); out.replaceChildren(node("p", `Resolved ${hits.length} of ${res?.requested ?? names.length}; ${fresh.length} new, ${hits.length - fresh.length} already here.`, "muted")); if (missing.length) out.append(node("p", `Not found in Dhan: ${missing.join(", ")}`, "error")); if (!fresh.length) return; const add = node("button", `Add ${fresh.length} to ${active.name}`); add.onclick = () => { fresh.forEach((h) => active.items.push({ name: h.name, symbol: h.symbol, exchange: "NSE" })); if (!saveModel(model)) return; done(); renderWatchlist(); }; out.append(add); } catch (e) { out.replaceChildren(node("p", e.message, "error")); } finally { resolve.disabled = published.disabled = false; } }; resolve.onclick = () => run(""); published.onclick = () => run("ath"); buttons.append(resolve, published, cancel); form.append(box, buttons, out); form.onkeydown = (e) => { if (e.key === "Escape") done(); }; return form; }
  const SORT_KEYS = [["symbol", "Symbol"], ["last", "Last"], ["change", "Chg"], ["changePercent", "Chg%"]];
  const sortValue = (stock, key) => { if (key === "symbol") return stock.symbol.split(":").at(-1); const quote = quoteData.get(stock.symbol); return quote ? quote[key] ?? null : null; };
  // Rows without a quote sort last in both directions -- flipping the direction
  // must not promote "no data" to the top of the list.
  function sortStocks(stocks, sort) { return stocks.slice().sort((a, b) => { const x = sortValue(a, sort.key), y = sortValue(b, sort.key); const missing = (v) => v === null || v === undefined || v === ""; if (missing(x) && missing(y)) return 0; if (missing(x)) return 1; if (missing(y)) return -1; const order = typeof x === "string" ? String(x).localeCompare(String(y)) : x - y; return sort.dir === "desc" ? -order : order; }); }
  // Click cycles ascending -> descending -> back to your own order, and the
  // choice is stored with the lists.
  function listHeader(sort, quoted = true) { const head = node("div", null, "col-head"); SORT_KEYS.filter(([key]) => quoted || key === "symbol").forEach(([key, label]) => { const on = sort && sort.key === key; const b = node("button", `${label}${on ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}`, on ? "col-sort on" : "col-sort"); b.setAttribute("aria-label", `Sort by ${label}`); b.onclick = () => { model.sort = !on ? { key, dir: "asc" } : sort.dir === "asc" ? { key, dir: "desc" } : null; saveModel(model); renderWatchlist(); }; head.append(b); }); return head; }
  // A sort is a view; a manual move is an order. Rather than refuse the drag,
  // freeze what is on screen as the list's own order and drop the sort, so the
  // rows never jump out from under the pointer.
  function commitSortedOrder(active) { const sort = model.sort; if (!sort) return; const out = []; let run = []; const flush = () => { sortStocks(run, sort).forEach((x) => out.push(x)); run = []; }; (active.items || []).forEach((entry) => { if (entry && entry.section != null) { flush(); out.push(entry); } else if (entry) run.push(entry); }); flush(); active.items = out; model.sort = null; }
  // A divider is a boundary, not a container: dragging one moves only the
  // divider and leaves every symbol where it is, so dropping it between two
  // rows just changes where the grouping starts. Carrying its symbols along
  // would reshuffle the list, and would pin a divider sitting at the top,
  // since every drop target would then be inside its own block.
  function moveWithin(active, dragged, target) { if (!dragged || !target || dragged === target) return; commitSortedOrder(active); const rest = active.items.filter((x) => x !== dragged); const at = rest.indexOf(target); rest.splice(at < 0 ? rest.length : at, 0, dragged); active.items = rest; saveModel(model); renderWatchlist(); }
  // The whole row is the drag source, so its label is a div with a button role
  // rather than a real <button>: Chrome refuses to start an ancestor drag from a
  // mousedown on a form control, which is what made dragging feel dead. A click
  // still selects, because a drag suppresses the click that would follow it.
  function dragRow(row, entry, active) { row.draggable = true; row.ondragstart = (e) => { dragging = entry; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", entry.symbol || entry.section || ""); }; row.ondragend = () => { dragging = null; document.querySelectorAll(".drop-target").forEach((x) => x.classList.remove("drop-target")); }; row.ondragover = (e) => { if (!dragging || dragging === entry) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; row.classList.add("drop-target"); }; row.ondragleave = () => row.classList.remove("drop-target"); row.ondrop = (e) => { e.preventDefault(); row.classList.remove("drop-target"); moveWithin(active, dragging, entry); }; }
  function nudge(active, stock, step) { commitSortedOrder(active); const items = active.items.slice(); const from = items.indexOf(stock); const to = from + step; if (from < 0 || to < 0 || to >= items.length) return; items.splice(to, 0, ...items.splice(from, 1)); active.items = items; saveModel(model); renderWatchlist(); }
  const FLAG_BY_COMMAND = { "flag-red": "red", "flag-orange": "orange", "flag-yellow": "yellow", "flag-green": "green", "flag-blue": "blue", "flag-none": "" };
  // Shortcuts pressed on the Dhan chart arrive here with the symbol already
  // resolved; the panel owns the lists, so it is the panel that writes.
  function panelCommand(msg) { if (msg.command === "next-symbol") { advance(); return; } const symbol = String(msg.symbol || ""); if (!/^NSEE\d+:[A-Z0-9.&()' -]{1,60}$/.test(symbol)) return; const ticker = symbol.split(":").at(-1); const stock = { name: clean(msg.name) || ticker, symbol, exchange: "NSE" };
    if (msg.command === "add-to-watchlist") { const list = activeList(); if (list.flag) { showStatus("Colour lists follow their flags - switch to a watchlist to add symbols", true); return; } if (list.items.some((x) => x.symbol === symbol)) { showStatus(`${stock.name} is already in ${list.name}`); return; } list.items.push(stock); model.instruments[symbol] = stock; if (saveModel(model)) { renderWatchlist(); showStatus(`Added ${stock.name} to ${list.name}`); } return; }
    if (!(msg.command in FLAG_BY_COMMAND)) return; const colour = FLAG_BY_COMMAND[msg.command];
    if (!colour) { delete model.flags[symbol]; if (saveModel(model)) { renderWatchlist(); showStatus(`Removed ${stock.name}'s colour flag`); } return; }
    model.flags[symbol] = colour; model.instruments[symbol] = stock; if (saveModel(model)) { renderWatchlist(); showStatus(`${stock.name} flagged ${FLAG_LABEL[colour]}`); } }
  // The repo's cron rebuilds watchlist.json daily (NSE, within 20% of ATH), so
  // this list is a mirror, not user state: it is replaced wholesale, once a day.
  const ATH_NAME = "20% below ATH", ATH_ALIASES = [ATH_NAME, "6-Month Stocks"], ATH_KEY = "tradebaba:athSyncedOn";
  async function syncAthList() {
    const today = new Date().toISOString().slice(0, 10);
    if (activeTab == null || localStorage.getItem(ATH_KEY) === today) return;
    const stop = busy(`Refreshing ${ATH_NAME}\u2026`);
    try {
      const res = await chrome.runtime.sendMessage({ type: "bulkResolve", tabId: activeTab, names: [], source: "ath" });
      if (!res || res.error || !Array.isArray(res.hits) || !res.hits.length) { stop(`${ATH_NAME}: ${res?.error || "the published list resolved no symbols"}`, true); return; }
      // Fill the list this sync owns. If it owns none yet, an EMPTY list already
      // carrying one of these names is plainly meant for this and gets claimed;
      // a list with symbols in it is yours, so the sync takes its own name.
      let list = model.lists.find((l) => l.managed === "ath")
        || model.lists.find((l) => ATH_ALIASES.includes(l.name) && !symbolsOf(l).length);
      if (list) list.managed = "ath";
      else { const clash = model.lists.some((l) => l.name === ATH_NAME); list = { id: "list-ath", name: clash ? `${ATH_NAME} (auto)` : ATH_NAME, items: [], favorite: false, managed: "ath" }; model.lists.push(list); }
      list.items = res.hits.map((h) => ({ name: h.name, symbol: h.symbol, exchange: "NSE" }));
      if (!saveModel(model)) return;
      localStorage.setItem(ATH_KEY, today);
      renderWatchlist();
      stop(`${list.name}: ${list.items.length} of ${res.requested} symbols resolved`);
    } catch (e) { stop(`${ATH_NAME}: ${e.message}`, true); }
  }
  let charted = null;
  // Marks the row the chart is on, so going down a list you can see where you
  // were. Toggling a class beats re-rendering: the quote cells stay put.
  function markCharted() { document.querySelectorAll(".row-main[data-symbol]").forEach((row) => row.classList.toggle("charted", row.dataset.symbol === charted)); }
  // Space walks down the list in the order shown - sorted, filtered or your own
  // - and wraps at the end.
  function advance() { const rows = [...document.querySelectorAll(".row-main[data-symbol]")]; if (!rows.length) return; const at = rows.findIndex((r) => r.dataset.symbol === charted); const next = rows[(at + 1) % rows.length]; const list = activeList(); const stock = symbolsOf(list).find((x) => x.symbol === next.dataset.symbol) || knownInstruments().get(next.dataset.symbol); if (stock) { select(stock, next); next.scrollIntoView({ block: "nearest" }); next.focus({ preventScroll: true }); } }
  let visibleTimer = null, railScroll = null;
  // Quote what is on screen. A published list runs to hundreds of names and the
  // feed answers 50 at a time, so asking for all of them prices the top and
  // truncates the rest. Geometry rather than IntersectionObserver: the panel is
  // often unpainted (hidden pane), and an observer reports nothing there, which
  // would quietly stop quotes altogether.
  function visibleSymbols(rail, rows, margin = 1200) {
    if (!rail || !rail.clientHeight) return rows.slice(0, 60).map((r) => r.dataset.symbol);
    const top = rail.scrollTop - margin, bottom = rail.scrollTop + rail.clientHeight + margin;
    const shown = rows.filter((r) => r.offsetTop + r.offsetHeight >= top && r.offsetTop <= bottom).map((r) => r.dataset.symbol);
    return shown.length ? shown : rows.slice(0, 60).map((r) => r.dataset.symbol);
  }
  // Past this a list is a screener, not a watchlist: no quotes are fetched and
  // the price columns are not drawn at all, rather than a screenful of dashes.
  const QUOTE_LIST_MAX = 200;
  const QUOTE_LIMIT = 1000;
  let backfillTimer = null, backfillToken = 0;
  // Quoting only what is on screen means every row you scroll to arrives blank
  // and fills a moment later. Walk the rest of the list in the background so it
  // is priced before you get there; the visible rows still go first.
  function backfill(symbols) {
    clearTimeout(backfillTimer);
    const token = ++backfillToken;
    const pending = symbols.filter((symbol) => !quoteData.has(symbol));
    if (!pending.length) return;
    const step = async (from) => {
      if (token !== backfillToken || activeTab == null) return;
      const chunk = pending.slice(from, from + 200);
      if (!chunk.length) return;
      try {
        const res = await chrome.runtime.sendMessage({ type: "getQuotes", tabId: activeTab, symbols: chunk });
        if (token !== backfillToken) return;
        if (res?.error) return;
        (Array.isArray(res.quotes) ? res.quotes : []).forEach((q) => paintQuote(q.symbol, q));
      } catch (_) { return; }
      backfillTimer = setTimeout(() => step(from + 200), 150);
    };
    step(0);
  }
  function watchVisible() {
    // The gate lives here because every quote path comes through this function:
    // a screener-sized list asks for nothing at all.
    const active = activeList();
    if (symbolsOf(active).length > QUOTE_LIST_MAX) { clearTimeout(quoteTimer); clearTimeout(backfillTimer); backfillToken++; quoteSequence++; noteQuotes(`Screener view: ${symbolsOf(active).length} symbols, so prices are off above ${QUOTE_LIST_MAX}.`); return; }
    const rail = $("stocks") && $("stocks").closest(".sample");
    const rows = [...document.querySelectorAll(".row-main[data-symbol]")];
    if (rail && railScroll) rail.removeEventListener("scroll", railScroll);
    if (!rows.length) return;
    // A short list is cheaper to ask for whole than to keep measuring.
    if (rows.length <= 100) { const all = rows.map((r) => r.dataset.symbol); watchQuotes(all); refreshQuotes(all); return; }
    const all = rows.map((r) => r.dataset.symbol);
    const ask = () => refreshQuotes(visibleSymbols(rail, rows));
    // One subscription for the list, not one per scroll.
    watchQuotes(all.slice(0, QUOTE_LIMIT));
    railScroll = () => { clearTimeout(visibleTimer); visibleTimer = setTimeout(ask, 250); };
    if (rail) rail.addEventListener("scroll", railScroll, { passive: true });
    ask();
    setTimeout(() => backfill(all), 800);
  }
  function renderWatchlist() { const list = $("stocks"); if (!list) return; quoteCells.clear(); clearTimeout(quoteTimer); quoteSequence++; list.replaceChildren(); const active = activeList(); const head = listHead(active); list.append(head); if (pickerOpen) list.append(listPicker(active)); const search = document.createElement("input"); search.placeholder = "Search or add NSE symbol"; search.className = "list-search"; search.setAttribute("aria-label", "Filter this list, or search Dhan for a symbol to add"); const results = node("div", null, "search-results"); results.hidden = true; quoteNote = node("p", null, "muted quote-note"); quoteNote.hidden = true; const rows = node("div", null, "stock-list"); const draw = () => { rows.replaceChildren(); quoteCells.clear(); const q = clean(search.value).toLowerCase(); const sort = model.sort; const movable = !active.flag; const shown = []; if (q) { const hits = symbolsOf(active).filter((x) => `${x.name} ${x.symbol}`.toLowerCase().includes(q)); (sort ? sortStocks(hits, sort) : hits).forEach((x) => shown.push(x)); } else { let open = true, run = []; const flush = () => { (sort ? sortStocks(run, sort) : run).forEach((x) => shown.push(x)); run = []; }; (active.items || []).forEach((entry) => { if (entry && entry.section != null) { flush(); open = !entry.collapsed; shown.push(entry); } else if (open && entry && entry.symbol) run.push(entry); }); flush(); } const stocks = shown.filter((x) => x.symbol); const quoted = symbolsOf(active).length <= QUOTE_LIST_MAX; if (!symbolsOf(active).length || (q && !stocks.length)) rows.append(node("p", q ? "No matching symbols in this list" : active.flag ? "No symbols carry this colour" : "No symbols in this list", "muted")); shown.forEach((entry) => rows.append(entry.section != null ? sectionRow(entry, active, movable) : stockRow(entry, active, movable, quoted))); watchVisible(); }; let debounce = null; search.oninput = () => { draw(); clearTimeout(debounce); const q = clean(search.value); if (q.length < 2) { searchSequence++; results.hidden = true; results.replaceChildren(); return; } debounce = setTimeout(() => searchSymbols(q, results), 250); }; list.append(search, results, quoteNote, listHeader(model.sort, symbolsOf(active).length <= QUOTE_LIST_MAX), rows); draw(); }
  async function select(stock, button) { if (activeTab == null) { showStatus("Open a Dhan chart to change symbols", true); return; } document.querySelectorAll(".row-main.selected").forEach((x) => x.classList.remove("selected")); if (button) { button.classList.add("selected"); button.classList.add("busy"); } const stopChart = busy(`Requesting ${stock.name} chart…`); const token = ++sequence; try { const result = await chrome.runtime.sendMessage({ type: "setChart", tabId: activeTab, symbol: stock.symbol }); if (token !== sequence) { stopChart(null); return; } if (result?.error) throw new Error(result.error); stopChart("Chart change accepted; waiting for Screener data…"); } catch (e) { stopChart(token === sequence ? e.message : null, true); } finally { if (button) button.classList.remove("busy"); } }
  function setRail(px) { const width = Math.min(520, Math.max(120, Math.round(px))); document.documentElement.style.setProperty("--rail", `${width}px`); return width; }
  function splitter() { const bar = $("divider"); if (!bar) return; const stored = Number(localStorage.getItem(WIDTH_KEY)); if (Number.isFinite(stored) && stored > 0) setRail(stored); const store = (width) => { try { localStorage.setItem(WIDTH_KEY, String(width)); } catch (_) {} }; let width = 0; const move = (e) => { e.preventDefault(); width = setRail(e.clientX); }; const stop = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", stop); if (width) store(width); }; bar.onpointerdown = (e) => { e.preventDefault(); document.addEventListener("pointermove", move); document.addEventListener("pointerup", stop); }; bar.onkeydown = (e) => { const step = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0; if (!step) return; e.preventDefault(); store(setRail(bar.getBoundingClientRect().left + step)); }; }
  // Screener publishes a price, not a tick: it is a delayed page figure with no
  // change field, so it fills Last for the charted row only, is labelled as
  // such, and never overwrites a live quote.
  function screenerQuote(payload, parsed) { const cells = [...quoteCells.entries()].find(([symbol]) => clean(payload.name).toUpperCase().includes(symbol.split(":").at(-1)) || symbol.split(":").at(-1) === clean(payload.name).toUpperCase()); if (!cells) return; const [symbol, nodes] = cells; if (quoteData.get(symbol)?.last != null) return; const price = number(parsed.ratios.get("Current Price")); if (price === null) return; nodes.last.textContent = price.toFixed(2); nodes.last.title = "From Screener, delayed - no live feed"; nodes.last.classList.add("stale"); }
  const SECTION_KEY = "tradebaba:sections";
  const SECTIONS = [["ratios", "Key Ratios"], ["analysis", "Pros and Cons"], ["quarters", "Quarterly Results"], ["profit", "Profit & Loss"], ["growth", "Growth"], ["shareholding", "Shareholding Pattern"]];
  function sectionPrefs() { try { const x = JSON.parse(localStorage.getItem(SECTION_KEY)); if (x && typeof x === "object") return { order: Array.isArray(x.order) ? x.order : [], collapsed: x.collapsed && typeof x.collapsed === "object" ? x.collapsed : {} }; } catch (_) {} return { order: [], collapsed: {} }; }
  function saveSections(prefs) { try { localStorage.setItem(SECTION_KEY, JSON.stringify(prefs)); } catch (_) { showStatus("Changes could not be saved", true); } }
  // Key Ratios is pinned first; a stored order covers the rest, and a section
  // added in a later version lands at the end instead of vanishing.
  function sectionOrder() { const stored = sectionPrefs().order; const movable = SECTIONS.map(([id]) => id).filter((id) => id !== "ratios"); const kept = stored.filter((id) => movable.includes(id)); return ["ratios", ...kept, ...movable.filter((id) => !kept.includes(id))]; }
  function moveSection(from, to) { if (!from || !to || from === to || to === "ratios") return; const prefs = sectionPrefs(); const rest = sectionOrder().filter((id) => id !== "ratios" && id !== from); rest.splice(rest.indexOf(to), 0, from); prefs.order = rest; saveSections(prefs); render(current, true); }
  let draggingSection = null;
  // The card is its own drag source, heading and contents together. Its data
  // tables opt out, so the numbers stay selectable and scrollable.
  function dragCard(wrap, id, movable) { if (movable) { wrap.draggable = true; wrap.ondragstart = (e) => { draggingSection = id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", id); }; wrap.ondragend = () => { draggingSection = null; document.querySelectorAll(".card.drop-target").forEach((x) => x.classList.remove("drop-target")); }; } wrap.ondragover = (e) => { if (!draggingSection || draggingSection === id || id === "ratios") return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; wrap.classList.add("drop-target"); }; wrap.ondragleave = () => wrap.classList.remove("drop-target"); wrap.ondrop = (e) => { e.preventDefault(); wrap.classList.remove("drop-target"); moveSection(draggingSection, id); }; }
  // A collapsed card builds no body at all: the tables are the expensive part,
  // so folding one away also stops rendering it.
  function card(id, title, build) { const collapsed = sectionPrefs().collapsed[id] === true; const movable = id !== "ratios"; const wrap = node("section", null, movable ? "card movable" : "card"); wrap.dataset.section = id; const head = node("div", null, "card-head"); const toggle = node("div", null, "card-toggle"); toggle.setAttribute("role", "button"); toggle.tabIndex = 0; toggle.setAttribute("aria-expanded", String(!collapsed)); toggle.append(node("span", collapsed ? "▸" : "▾", "caret"), node("h2", title)); const fold = () => { const prefs = sectionPrefs(); prefs.collapsed[id] = !collapsed; saveSections(prefs); render(current, true); }; toggle.onclick = fold; toggle.onkeydown = (e) => { if (e.key !== "Enter" && e.key !== " ") return; e.preventDefault(); fold(); }; head.append(toggle); wrap.append(head); dragCard(wrap, id, movable); if (!collapsed) build(wrap); wrap.querySelectorAll(".table-scroll").forEach((x) => { x.draggable = false; }); return wrap; }
  function growthTable(rows) { const wrap = node("div", null, "growth-table"); if (!rows.length) return wrap; const [heading, ...body] = rows; wrap.append(node("b", heading[0] || "")); body.forEach((r) => { const line = node("div", null, "ratio"); line.append(node("span", r[0] ?? ""), node("b", r[1] ?? "")); wrap.append(line); }); return wrap; }
  function section(title) { const s = document.createElement("section"); s.className = "card"; s.append(node("h2", title)); return s; }
  // Stepping through a list with Space changes the chart faster than Screener
  // answers, and each answer costs a DOMParser pass over a whole company page.
  // Coalesce the burst: only the last payload is worth rendering.
  let renderTimer = null, queued = null;
  function scheduleRender(payload) { queued = payload; clearTimeout(renderTimer); renderTimer = setTimeout(() => { const next = queued; queued = null; if (next) render(next); }, 200); }
  function render(payload, force = false) { if (!payload?.html) return; if (!force && current && current.url === payload.url && !$("body").hidden) return; const parsed = parse(payload.html), body = $("body"); current = payload; screenerQuote(payload, parsed); body.replaceChildren(); body.hidden = false; $("status").hidden = true; $("title").textContent = "TradeBaba"; $("source").href = payload.url; $("source").hidden = false; body.append(node("h1", payload.name || "", "company-name"));
    const build = {
      ratios: (host) => { const grid = node("div", null, "ratios"); parsed.ratios.forEach((v, k) => { const row = node("div", null, "ratio"); row.append(node("span", k), node("b", v)); grid.append(row); }); host.append(grid); },
      analysis: (host) => { const cols = node("div", null, "growth"); ["pros", "cons"].forEach((kind) => { const col = node("div", null, kind); col.append(node("b", kind === "pros" ? "Pros" : "Cons")); parsed[kind].forEach((x) => col.append(node("p", `${kind === "pros" ? "✓" : "•"} ${x}`))); cols.append(col); }); host.append(cols); },
      quarters: (host) => host.append(table(parsed.quarters, "quarters")),
      profit: (host) => host.append(table(parsed.profit, "profit")),
      growth: (host) => { if (!parsed.growth.length) { host.append(node("p", "Screener published no growth tables for this company.", "muted")); return; } parsed.growth.forEach((rows) => host.append(growthTable(rows))); },
      shareholding: (host) => host.append(node("p", "Each period compared with its previous period.", "muted"), table(parsed.shareholding, "shareholding")),
    };
    const titles = Object.fromEntries(SECTIONS);
    sectionOrder().forEach((id) => body.append(card(id, titles[id], build[id])));
  }
  // Only the browser can bind a key, so a row cannot capture one: clicking it
  // opens the browser's own shortcuts page. getAll() reports the real bindings,
  // including any the user changed, so nothing here is a hardcoded guess.
  function shortcutsCard() { const card = section("Shortcuts"); card.append(node("p", "Pressed on the Dhan chart. Click a row to set or change it - only the browser can bind a key, so this opens its shortcuts page.", "muted")); const list = node("div", null, "shortcut-list"); card.append(list); chrome.commands?.getAll?.().then((commands) => { (commands || []).forEach((c) => { const row = node("button", null, c.shortcut ? "shortcut-row" : "shortcut-row unset"); row.type = "button"; row.title = c.shortcut ? "Change this shortcut" : "Set this shortcut"; row.append(node("span", c.description || c.name), node("b", c.shortcut || "Set\u2026")); row.onclick = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }); list.append(row); }); }).catch(() => list.append(node("p", "This browser did not report any shortcuts.", "muted"))); return card; }
  function panelCard() { const card = section("Opening the panel"); const row = node("div", null, "setting-row"); const box = document.createElement("input"); box.type = "checkbox"; box.setAttribute("aria-label", "Open TradeBaba automatically on tv.dhan.co"); chrome.storage.local.get(AUTO_KEY).then((stored) => { box.checked = stored[AUTO_KEY] !== false; }); box.onchange = () => chrome.storage.local.set({ [AUTO_KEY]: box.checked }); row.append(node("span", "Open automatically on tv.dhan.co"), box); card.append(node("p", "Chrome only lets an extension open its side panel from a gesture, so TradeBaba opens on your first click or keypress on the Dhan page. The toolbar button, Alt+D and the page's right-click menu open it too, and it stays open while you move around Dhan.", "muted"), row); return card; }
  // The token is written straight to chrome.storage.local and never rendered
  // back: the field shows whether one is saved, not what it is.
  // The daily stamp is invisible, so a stuck day needs a way out that is not
  // devtools.
  function publishedCard() { const card = section("Published lists"); const state = node("p", "", "muted"); const refresh = node("button", "Refresh now");
    const say = () => { const on = localStorage.getItem(ATH_KEY); const list = model.lists.find((l) => l.managed === "ath"); state.textContent = `${ATH_NAME}: ${list ? `${symbolsOf(list).length} symbols` : "not built yet"}${on ? `, last refreshed ${on}` : ", not refreshed today"}`; };
    refresh.onclick = async () => { try { localStorage.removeItem(ATH_KEY); } catch (_) {} refresh.disabled = true; await syncAthList(); say(); refresh.disabled = false; };
    card.append(node("p", "NSE names within 20% of their all-time high, rebuilt daily at 17:00 IST and pulled in once a day when the panel opens.", "muted"), state, refresh); say(); return card; }
  function backupCard() { const card = section("Watchlist backup"); const state = node("p", "Checking…", "muted"); const detail = node("div", null, "backup-detail"); const link = document.createElement("a"); link.target = "_blank"; link.rel = "noopener"; link.hidden = true;
    const token = document.createElement("input"); token.type = "password"; token.className = "list-search"; token.placeholder = "GitHub token with the Gists scope"; token.setAttribute("aria-label", "GitHub personal access token");
    const row = node("div", null, "flag-row"); const save = node("button", "Save token"); const push = node("button", "Back up now"); const pull = node("button", "Restore from gist"); const undo = node("button", "Undo last replace"); const fromSync = node("button", "Take browser-sync copy"); const forget = node("button", "Forget token"); row.append(save, push, pull, undo, fromSync, forget);
    const fail = (e) => { state.textContent = e.message || String(e); state.className = "error"; };
    // One gist, many revisions: show what it holds and when, rather than
    // asserting that a backup happened.
    const show = async () => { detail.replaceChildren(); const config = (await chrome.storage.local.get(GITHUB_KEY))[GITHUB_KEY] || {}; link.hidden = true; if (!config.token) { state.textContent = "No token saved. Backups stay on this device."; state.className = "muted"; return; }
      state.textContent = `Token ${config.tokenHint || "saved"}${config.gistId ? "" : " · no gist yet"}`; state.className = "muted";
      if (!config.gistId) return;
      try { const info = await chrome.runtime.sendMessage({ type: "backupInfo" }); if (info?.error) throw new Error(info.error);
        state.textContent = `Token ${info.token || config.tokenHint || "saved"} · gist ${info.gistId.slice(0, 7)} · ${info.revisions} revision${info.revisions === 1 ? "" : "s"}`;
        const total = info.lists.reduce((sum, l) => sum + l.count, 0);
        detail.append(node("p", `Stored ${info.lists.length} watchlist${info.lists.length === 1 ? "" : "s"}, ${total} symbol${total === 1 ? "" : "s"}, last written ${new Date(info.updatedAt).toLocaleString()}`, "muted"));
        info.lists.forEach((l) => { const line = node("div", null, "backup-line"); line.append(node("span", l.name), node("b", String(l.count))); detail.append(line); });
        link.href = info.url; link.textContent = "View the gist ↗"; link.hidden = false;
      } catch (e) { fail(e); } };
    // The gist is found from the token, so the token is the only thing to enter.
    save.onclick = async () => { const value = token.value.trim(); if (!value) return; const config = (await chrome.storage.local.get(GITHUB_KEY))[GITHUB_KEY] || {}; await chrome.storage.local.set({ [GITHUB_KEY]: { ...config, token: value, tokenHint: `••••${value.slice(-4)}` } }); token.value = ""; show(); };
    push.onclick = async () => { const stop = busy("Backing up…"); push.disabled = true; try { const res = await chrome.runtime.sendMessage({ type: "backupPush", model }); if (res?.error) throw new Error(res.error); stop("Backed up to the gist"); show(); } catch (e) { stop(null); fail(e); } finally { push.disabled = false; } };
    pull.onclick = () => askInline(card, "Restore from the gist? This device's watchlists are replaced, and the current ones are kept for Undo.", "Restore", async () => { const stop = busy("Reading the gist…"); try { const res = await chrome.runtime.sendMessage({ type: "backupPull" }); if (res?.error) throw new Error(res.error); if (!adopt(res.model)) throw new Error("the gist held no usable watchlists"); stop(`Restored ${res.model.lists.length} lists from the gist`); show(); } catch (e) { stop(null); fail(e); } });
    undo.onclick = () => askInline(card, "Put back the watchlists from before the last replace?", "Undo", () => { if (undoReplace()) { state.textContent = "Restored the watchlists from before the last replace."; state.className = "muted"; } else { fail(new Error("Nothing to undo on this device.")); } });
    fromSync.onclick = async () => { const stored = await syncedBackup(); if (!stored) { fail(new Error("The browser has no synced copy.")); return; } askInline(card, `Replace this device's watchlists with the synced copy from ${new Date(Number(stored.updatedAt) || 0).toLocaleString()}?`, "Replace", () => { const ok = adopt(stored); if (ok) { state.textContent = "Took the browser-synced copy."; state.className = "muted"; } else fail(new Error("Could not read the synced copy.")); }); };
    forget.onclick = () => askInline(card, "Forget the token and gist id on this device?", "Forget", async () => { await chrome.storage.local.remove(GITHUB_KEY); show(); });
    card.append(node("p", "Every change is written to one gist, about 5 seconds later; GitHub keeps each write as a revision. Any device with the token finds that gist on its own. Nothing is ever restored automatically, and Undo puts back whatever a restore replaced.", "muted"), state, detail, link, token, row); show(); return card; }
  function settingsView() { const body = $("body"); body.replaceChildren(); body.hidden = false; $("status").hidden = true; const card = section("Metric colours"); card.append(node("p", "Each period compared with its previous period.", "muted"));
    const found = new Map(); if (current) { const p = parse(current.html); [["quarters", p.quarters], ["profit", p.profit], ["shareholding", p.shareholding]].forEach(([id, rows]) => rows.slice(1).forEach((r) => r[0] && found.set(`${id}:${clean(r[0])}`, clean(r[0])))); }
    const settings = metricPrefs(), titles = Object.fromEntries(SECTIONS), groups = new Map();
    found.forEach((metric, id) => { const sectionId = id.slice(0, id.indexOf(":")); if (!groups.has(sectionId)) groups.set(sectionId, []); groups.get(sectionId).push([id, metric]); });
    groups.forEach((rows, sectionId) => { const fold = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = `${titles[sectionId] || sectionId} (${rows.length})`; fold.append(summary);
      rows.forEach(([id, metric]) => { const row = node("div", null, "setting-row"); const enabled = document.createElement("input"), invert = document.createElement("input"); enabled.type = invert.type = "checkbox"; const pref = settings[id] || settingFor(...id.split(":")); enabled.checked = pref.enabled === true; invert.checked = pref.invert === true; enabled.setAttribute("aria-label", `Enable ${metric}`); invert.setAttribute("aria-label", `Invert ${metric}`); enabled.onchange = () => { settings[id] = { ...settings[id], enabled: enabled.checked }; saveMetrics(settings); }; invert.onchange = () => { settings[id] = { ...settings[id], invert: invert.checked }; saveMetrics(settings); }; row.append(node("span", metric), node("label", "Enable"), enabled, node("label", "Invert"), invert); fold.append(row); });
      card.append(fold); });
    if (!groups.size) card.append(node("p", "Open a stock first - the metrics come from its Screener page.", "muted"));
    const back = node("button", "Back to analysis"); back.onclick = () => current && render(current, true); card.append(back); body.append(shortcutsCard(), panelCard(), publishedCard(), backupCard(), card); }
  async function load(tabId) { const token = ++sequence; activeTab = tabId; watchVisible(); syncAthList(); showStatus("Loading TradeBaba analysis…"); $("body").hidden = true; try { const payload = await chrome.runtime.sendMessage({ type: "getStock", tabId }); if (token !== sequence) return; if (!payload?.html) throw new Error("No stock data yet. Select a Dhan chart, then retry."); render(payload); } catch (e) { if (token === sequence) showStatus(e.message, true); } }
  function theme() { const value = localStorage.getItem(THEME_KEY); return value === "light" ? "light" : "dark"; }
  function setTheme(value) { const next = value === "light" ? "light" : "dark"; document.documentElement.dataset.theme = next; try { localStorage.setItem(THEME_KEY, next); } catch (_) {} }
  if (typeof window !== "undefined") window.tradebaba = { number, period, compare, parse, loadModel, defaults, marketOpen };
  if (typeof document === "undefined" || !$("body")) return;
  // Bubble phase, on click rather than pointerdown: whatever was clicked gets
  // its own handler first, so closing the picker never swallows that click.
  document.addEventListener("click", (e) => { if (!pickerOpen) return; const el = e.target instanceof Element ? e.target : null; if (el && el.closest(".list-picker, .list-button")) return; pickerOpen = false; renderWatchlist(); });
  document.addEventListener("keydown", (e) => { if (e.key !== " " || e.defaultPrevented) return; const t = e.target; if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return; e.preventDefault(); advance(); });
  document.addEventListener("visibilitychange", () => { if (panelVisible() && marketOpen()) watchVisible(); });
  setTheme(theme()); splitter(); renderWatchlist(); $("retry").onclick = async () => { const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); if (tabs[0]?.id != null) load(tabs[0].id); }; $("settings").onclick = settingsView; chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => { if (msg.type === "panelCommand") { panelCommand(msg); sendResponse({ ok: true }); return; } if (msg.type === "chartedSymbol") { charted = String(msg.symbol || "") || null; markCharted(); return; } if (msg.type === "quoteTick") { (Array.isArray(msg.quotes) ? msg.quotes : []).forEach((q) => paintQuote(q.symbol, q)); noteQuotes(""); return; } if (msg.type === "stockData" && msg.tabId === activeTab) { scheduleRender(msg); watchVisible(); } }); chrome.tabs.onActivated.addListener(({ tabId }) => load(tabId)); $("theme").onclick = () => setTheme(theme() === "dark" ? "light" : "dark"); (async () => { const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); if (tabs[0]?.id != null) load(tabs[0].id); })();
})();
