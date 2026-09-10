# TradeBaba UI implementation plan — Astra → Luna

Status: Stage A implementation and Step 9a checks complete, 2026-09-09. Astra research handoff complete; Luna finished the verified implementation work. No Dhan personal watchlist mutations.

## Status

Current owner: Parent — Steps 4–8 and 9a complete; Step 9b is browser-tool blocked and Stage B is contract-verification blocked. This ledger records actual results/blockers; planning alone never marks implementation complete.

- [x] Steps 1–3: official skill/docs/public UI references researched; feature matrix, file responsibilities, and root causes documented.
- [x] Step 4: Dhan visual tokens and responsive native-panel layout — implemented in `extension/sidepanel.html` and `extension/sidepanel.css`; `node --check extension/sidepanel.js` and `git diff --check` pass. Live browser visual check remains unverified.
- [x] Step 5: local watchlist management and persistence — implemented versioned local model, seed-once list, search, remove, empty states, create-list prompt, duplicate-safe rendering in `extension/sidepanel.js`. DOM/browser interaction not yet live-verified.
- [x] Step 6: chart identity/selection and full symbol addition — preserved validated `setChart` bridge and added list selection/pending/error handling. Full-market resolver/import remains Stage B blocker; no fabricated resolver.
- [x] Step 7: independent all-period financial comparisons — implemented immediate-adjacent period comparison, strict numeric parsing, missing/flat neutrality, per-cell classes and accessible labels in `extension/sidepanel.js`. Regression test coverage pending.
- [x] Step 8: shareholding/metric settings and persisted dark/light theme — implemented section-qualified settings including shareholding defaults and persisted validated theme token in `extension/sidepanel.js`/`.css`. Live settings interaction unverified.
- [x] Step 9a: runnable regression, syntax, and integration checks for implementation — `node --check` on all modified JS, `node extension/test.mjs`, `git diff --check`, and VM assertions for adjacent comparisons, missing predecessors, inversion, strict numeric parsing, and seed model all pass. Full DOM/browser interaction remains unverified.
- [x] Step 11: watchlist row data and actions, 2026-09-09 — Last/Chg/Chg% columns fed by the TradingView terminal datafeed's `getQuotes()` when the page exposes one (feature-detected in `main.js`; the columns stay em-dashes with a named reason otherwise, and the 10s poll stops on that error), per-row actions menu (colour flag, move/add to another list, remove/unflag), five colour lists (Red/Orange/Yellow/Green/Blue) derived from a global one-colour-per-symbol flag map, and Bulk add — paste a list or pull the published ATH list, resolved through `ScanWatchlist` with the sync's confidence bar and `findMissing()` report before anything is added. Stage C's "no fabricated quotes" boundary is kept: no Screener price is reused as an LTP.
- [x] Step 12: TradingView-shaped list picker, 2026-09-09 — the `<select>` and every `prompt()`/`confirm()` are gone. The list name is a toggle that opens an inline picker (New list, Watchlists with per-row rename/delete, Colour lists with swatches); rename/create edit in place with Enter/Escape, and destructive answers use an inline confirm bar. Verified in the DOM harness: rename commits, Escape cancels the edit without closing the picker, delete/clear confirm inline, cancel mutates nothing.
- [x] Step 9c: Step 9b failures fixed, 2026-09-09 — list picker/rename/delete/copy/clear, a draggable+keyboard-resizable watchlist/analysis divider with persisted width, and a working symbol-search dropdown backed by Dhan's read-only `ScanWatchlist`. Verified in a DOM harness (stubbed `chrome.*`): search results render, add persists and drives the chart, duplicate adds are refused, divider drags 230→300px and clamps to 120–520px, search error/empty states render. Live Dhan re-test still owed by the user.
- [ ] Step 9b: browser visual and live chart/list verification — unverified; required browser tool unavailable during research. Public reference images were inspected, not the running extension.
- [x] Step 10: Markdown plan saved for Luna handoff; production files unchanged by Astra. `rtk proxy git diff --check` passed at design handoff (not implementation validation).
- [ ] Stage B full symbol resolution/import — blocked pending safe contract verification: existing `main.js` `scan()` calls authenticated Dhan `ScanWatchlist` through encrypted `reqObjectOG`; response/security-ID shape and read-only guarantees are not verified from available fixtures. No resolver/import fabricated; current-chart additions remain available.
- [ ] Stage C quote/service-dependent features — deferred with explicit dependencies in Step 2; no claim of full TradingView feature parity.

## 1. Evidence and design contract

**Behavior = TradingView website. Appearance = tv.dhan.co.** This is not a new artistic redesign and not merely a cosmetic four-stock demo.

Applied skill: official [`anthropics/skills` frontend-design](https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md), fetched and read. Apply its reference-first brief, compact tokens, plan/review/critique, and accessibility guidance. Its explicit instruction that the client's visual direction wins overrides creative flourishes. No global skill installation or new production dependency.

Sources actually read:
- **TV1** [Mastering the TradingView watchlists](https://www.tradingview.com/support/solutions/43000745825/): current website features, menu actions, symbol search, reorder, sections, columns, symbol details, notes, advanced mode.
- **TV2** [Watchlist advanced view mode](https://www.tradingview.com/support/solutions/43000771546/): Overview/Financials/Performance/Risk/Technicals, Earnings/Dividends/News, currency conversion, summaries, grouping, export.
- **TV3** [Import/export](https://www.tradingview.com/support/solutions/43000487233/): exchange-prefixed comma-separated TXT; download available through advanced view.
- **TV4** [Red list](https://www.tradingview.com/support/solutions/43000645264/): built-in flagged list cannot be deleted.
- **TV5** [Charting Library watchlist](https://www.tradingview.com/charting-library-docs/latest/trading_terminal/Watch-List/): supporting docs only, not a substitute for website behavior. Context7 resolve-library-id then query-docs used `/websites/tradingview_charting-library-docs_v29`. Website-support Context7 queries returned no matching content, so official website guides above were fetched directly.
- **D1** [Dhan public app](https://tv.dhan.co/) and its linked [actual stylesheet](https://tv.dhan.co/style3.0.18.css): inspected public HTML/CSS, including light/dark variables and system font stack. Versioned URL may change; rediscover via public HTML if necessary.
- **D2** [Dhan product page](https://dhan.co/tradingview/): official chart screenshots.

Visual evidence actually opened with image viewer:
- [Dhan chart](https://stock-logos.dhan.co/static-new-images/deepintegrationwebscreen.png): light canvas, compact toolbar, narrow separators, plain controls, restrained green/red.
- [Dhan layout popup](https://stock-logos.dhan.co/static-new-images/customisationwebscreen.png): compact plain menu, row separators, blue selection. Orange outline is marketing annotation, NOT a theme token.
- [TradingView website list dropdown](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/43611966792/original/by5tFFG2ygRaPdSXG6a9Lw1V0uW8vmkM4A.png?1773416841): named picker, plus, overflow, copy/rename/section/clear/create/upload, recently used, Red list, row trash action, compact numeric columns.
- [TradingView library watchlist anatomy](https://www.tradingview.com/charting-library-docs/assets/images/watchlist-165bfd72ff76eb3666c7c5c295071e2a.png): section labels, Symbol/Last/Chg/Chg%, selected row outline. This is library UI, separately labeled.

Limitations: no live browser inspection or live extension screenshot occurred; browser skill was read and required browser `js` tool was not exposed. Public screenshots are not proof of today's authenticated Dhan watchlist. Actual dark palette and font below come from current public Dhan CSS; exact row dimensions are proposed adaptation, not measured pixels. Do not claim pixel-perfect or full TradingView parity without execution verification. Flag multi-membership/subscription limits were not verified (one help page returned 404); use explicitly documented local behavior below rather than claim exact parity.

## 2. Feature matrix and staged scope

Stage A = execute now using local state + existing chart bridge. Stage B = implement after proving safe read-only symbol resolution; cannot call it complete while still four-stock-only. Stage C = explicitly data/service-dependent follow-up, not fake functionality.

| TradingView capability | Stage / TradeBaba implementation | Boundary / acceptance | Source |
|---|---|---|---|
| Named regular lists | A: create, rename, duplicate, delete, clear; picker with recent/favorite lists | Persist stable list IDs; confirm clear/delete; deleting list never deletes instruments elsewhere | TV1, observed menu |
| Colored flag lists | A: Red always available; named red/blue/green/orange/purple views; flag/unflag each instrument | Proposed local model: one flag color per instrument globally; changing it moves flagged-list membership, not regular membership. Explain local behavior; palette/multi-flag exact TV parity unverified | TV4, observed Red list; remaining colors are explicit adaptation |
| Sections / grouping | A: add, rename, move, remove divider; move stocks between sections | Removing divider retains its rows; custom order survives reload | TV1 |
| Select stock / change chart | A: preserve working setChart path; pending separate from selected | Chart-observed symbol, not click alone, confirms selected row and drives financials | Existing user-confirmed flow, TV5 |
| Add/remove/search stocks | A: search current catalog and add selected chart; B: searchable full supported NSE catalog via safe existing resolver | Never invent security IDs; explicit result selection, duplicate guard, remove from current regular list only; no Dhan list writes | TV1 |
| Manual order / sorting | A: drag reorder + keyboard move up/down; symbol/name ascending/descending/custom; sort within sections | Restore custom order when sort reset; disable drag during sorted view with explanation | TV1 |
| Row presentation | A: ticker/name toggles, compact standard rows/data table, hover/focus remove and flag actions | Default ticker prominent, name secondary; logo optional only with trusted known source, otherwise no fake icon | TV1 |
| Last / Chg / Chg% / Volume / extended hours | C until verified quote feed | No live endpoint currently in panel. Do not reuse Screener Current Price as live LTP or fabricate zero changes. Hide unavailable columns; column settings explain availability. Show timestamp/delay once feed exists | TV1 |
| Column sorting/resizing/visibility | A for identity columns; C quote columns | Accessible separators/keyboard resizing only when multi-column layout exists; min widths; persist widths and sort | TV1, support index |
| Import/export | B: export exchange-prefixed TXT; import preview resolves symbols, reports unsupported/unresolved entries, confirms before adding | Atomic local changes, bounded file size/count, no silently discarded tickers; JSON backup may additionally preserve flags/sections/notes | TV3 |
| Favorites/recent lists | A local favorites and recent picker entries | No TradingView account sync | TV1 |
| Notes / symbol details | A local per-instrument notes; existing Screener financial pane retained | Chart is details source; no suggestion all TV detail categories exist | TV1 |
| Share list / cloud sync | C: service-dependent, not a dead share button | Local export available; no public upload or sharing without explicit user action | TV1, TV3 |
| Watchlist alerts | C: quote data + conditions + scheduling/notification reliability needed | Do not render inert active controls; explain unavailable in feature availability/help | TV1 |
| Hotlists / news / technical summaries | C: requires licensed/reliable source | Existing ATH workflow is unrelated; do not repurpose or modify it here | TV1, TV2 |
| Advanced view, calendars, sector distributions, currency conversion, summaries | C after required datasets verified | No empty dashboard imitation; separately scoped milestone. Local list UI alone is not full TV parity | TV2 |
| Other exchanges / assets | C until current NSEE-only chart validator and resolver safely support them | Unsupported instruments reported, never coerced to NSE | Existing bridge validation |
| Platform paid limits | Not copied as artificial local caps | TV account/feed entitlements are not extension capabilities; exact tier limits unverified | TV docs availability varies |

## 3. Files and current root causes

- `extension/sidepanel.js`: active parser/render/settings and four-stock buttons. `table()` currently compares final two numeric values for every shareholding cell; financial colors guarded by `ci === r.length - 1`; `.filter(Number.isFinite)` silently skips missing predecessors. Settings enumerates quarters/profit but omits shareholding. Fix one section-aware cell comparison path, not caller-specific patches.
- `extension/sidepanel.html`: semantic shell; remove inline layout styles. Current <=560px rule stacks the watchlist above financials, contrary to requested persistent two-column layout.
- `extension/sidepanel.css`: all visual tokens, layout, states, controls, tables/settings. `.stock-row` currently lacks dedicated styling.
- `extension/background.js`: cached per-tab payload and command routing; add only validated metadata/search routing if necessary. Payload currently lacks canonical chart symbol, so exact selection must gain explicit identity rather than fuzzy company-name matching.
- `extension/main.js`: existing `scan(names)` calls `ScanWatchlist`; inspect full read-only behavior and response before reuse for symbol resolution. Keep existing importer paths untouched. `watchChartSymbol()` currently strips canonical symbol to ticker; preserve canonical identity in additional metadata without breaking current consumers. `mountScreener()` contains a duplicate old table renderer, but `whenReady()` does NOT call it. Do not re-enable overlay. Leave dormant implementation out of active UI scope or remove only with clear no-call evidence; do not create a new shared renderer framework for dead code.
- `extension/bridge.js`: preserve set-chart correlation/timeout; narrowly add validated metadata/search replies as needed. No credentials forwarded into panel.
- `extension/test.mjs`: extend existing Node assertions before its optional-HAR `process.exit(0)`. Use small testable pure helpers in `sidepanel.js` loaded by VM, or one `extension/sidepanel-model.js` if required for browser+Node reuse; no new production dependency/framework.
- `README.md`: brief supported/unsupported feature and reload/test notes only. Preserve concurrent edits.

## 4. Dhan visual tokens and layout — implement first

Directly observed Dhan CSS values (D1), mapped to local CSS variables:

| Token | Light | Dark |
|---|---|---|
| Surface | `#FFFFFF` | `#1F1F1F` |
| Raised/selected surface | `#F1F3FA` | `#2E2E2E` |
| Primary text | `#131722` | `#D2D4DC` |
| Secondary text | `#787B86` | `#8C8C8C` |
| Divider | `#E0E3EB` | `#4A4A4A` |
| Input border | `#D1D4DC` | `#575757` |
| Hover | `#EBEBEB` | `#3D3D3D` |
| Action/focus blue | `#295CED` | `#295CED` |
| Market up / down | `#089981` / `#F23645` | same source values |
| Scroll thumb / track | `#E2E2E2` / `#F1F3FA` | `#6B6B6B` / `#2D2D2D` |

Accessibility overrides are intentional, not inaccurate source claims: test contrast; use darker green/red for small light-theme text (starting candidates `#087F6B`/`#CF2435`) and brighter dark text if needed (`#22AB94`/`#FF6570`). Secondary text must meet 4.5:1 for small labels; adjust light muted to `#626672` if necessary. Keep source colors for nontext marks where appropriate. Favor colored text with very subtle tint, not large saturated cells.

Font: actual Dhan stack `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. No downloads. Base 13px; numbers 12–13px with `font-variant-numeric: tabular-nums`; headings 14px/600; secondary names 11–12px. Proposed rows 32px (40px when description enabled), toolbar 36px, 6–8px horizontal cell padding, 4px control radius, 1px separators. No card shadows, hero, gradients, decorative badges, or auto animation.

```text
TradeBaba                         [Theme] [Settings] [Retry]
┌ Named list ▾   +   … ┬ Selected chart/company   Source ↗ ┐
│ Search list         │ Key ratios                         │
│ Flag  Symbol   …    │ Quarterly results [horizontal →]  │
│ Section             │ Profit & loss     [horizontal →]  │
│ ▷ RELIANCE          │ Shareholding      [horizontal →]  │
│   Reliance Ind…     │ Pros/cons and growth              │
│                     │                                    │
└ independent scroll ┴ independent vertical scroll ──────┘
```

Use viewport-height grid shell: header + `minmax(0,1fr)` content. Left `clamp(140px, 27vw, 230px)` and right `minmax(0,1fr)`; both `min-height:0; overflow:auto`. At narrow native-panel widths use 120–140px symbol-only left rail, hide names before reducing numeric legibility. Never turn it into an overlay or force Dhan chart width. Each financial table gets a horizontal scroll wrapper; row labels sticky and theme-opaque, header sticky within appropriate wrapper, latest columns initially visible. No outer horizontal page scroll. At very narrow widths right pane still exists and tables scroll; optional user collapse is not the default layout.

## 5. Local watchlist model and management

Persist one versioned local object under `tradebaba:watchlists:v1`: lists `{id,name,items:[instrument or section references],favorite}`, instruments keyed by canonical symbol `{symbol,ticker,name,exchange}`, `flags`, `notes`, `activeListId`, `recentListIds`, view/sort settings. Seed existing four stocks once only; an intentionally emptied list must remain empty after reload. Reuse localStorage conventions in existing panel; validate stored shape and recover corrupt values without erasing unrelated preferences. Storage failure must show “Changes could not be saved” rather than silently reporting success.

Regular lists and derived flag lists are distinct. A flag is classification, not favourable/unfavourable performance. Red flag never paints the whole row as a loss. Deleting a regular list does not remove global flags or notes. Clear flagged list unflags its members after confirmation; Red list entry itself persists. Names trimmed/nonempty with bounded length; symbols strictly validated; prevent duplicate membership. Use textContent, never user-string HTML. Focus returns to invoking button after menus/dialogs; Escape closes and cancel never mutates.

## 6. Chart selection and full symbol addition

Preserve `sidepanel → background → bridge → MAIN activeChart().setSymbol()` exactly as working base. Requested symbol has pending indicator; confirmed chart identity has selected styling. Selection via Dhan itself must update extension highlighting; if outside the current list show company in financial pane without silently adding it. Add-current-chart is explicit. Never invoke `addWatchlist`, update/delete-watchlist, or automatic sync from this UI.

Add canonical chart identity to chart-observer result/cache. Reject stale completions after tab/stock switches: track request identity, ensure older Screener request cannot overwrite newer cached/current stock. Background and panel both need sequence/identity checks when asynchronous responses race. Keep previous details visibly labeled as stale/loading or hide them, never label old company data as new.

For Stage B, inspect/reuse existing `scan()` as a **read-only** lookup only, return limited normalized NSE-equity results via strict bridge messages. No new credential handling; no session/profile inspection. If actual lookup contract cannot be verified safely, report blocker and retain catalog/current-chart addition—not a fabricated full-market search. Imports resolve exchange+ticker to canonical ID using same path, show preview/errors, then atomically add approved results.

## 7. Correct all-period financial comparison

One comparison function receives full source header+row, current source index, section, metric setting. Parse calendar headers deliberately (month-year including `Mar2026`, `Mar 2026`, `Jun 2026`; supported quarter/year forms); reorder header+cells together if source descending. Compare each period with immediate chronological source predecessor of the same series, not last column and not previous valid number. TTM is neutral, never compared with annual value. Unknown/non-period headers neutral; do not sort or color CAGR 3Y/5Y/10Y windows as chronological financial periods. Quarterly/monthly and annual sections remain separate.

Parse complete normalized numeric strings, not permissive parseFloat prefixes: preserve zero/negative, strip Indian grouping commas and permitted currency/percent wrappers, support minus/Unicode minus and parenthesized negatives; blanks/dashes/N/A/text/nonfinite remain missing. Never coerce missing to zero. If units differ, normalize explicitly or remain neutral. Missing immediate predecessor makes current cell neutral (do not skip over the hole). First period without predecessor and exact flats neutral. Compare full source before any column trimming; first visible period may legitimately have a hidden predecessor.

Compute **actual direction** (`increase/decrease/flat/unavailable`) separately from **configured favourability** (invert). Example tooltip/accessible label: “Jun 2026: 20.1%, increased from Mar 2026: 19.8% (+0.3 percentage points); configured favourable.” Public increase still says increased, even when red. Optional tiny arrow reflects actual direction, not inverted outcome. Every numeric period independently colored only when enabled.

## 8. Settings and theme

Enumerate every nonempty row from quarters, profit and shareholding; IDs section-qualified. Preserve current keys `quarters:<row>` and `profit:<row>` where possible. Normalize whitespace/trailing presentation plus signs for new identity with migration from existing raw keys; never merge identical names across sections. Match shareholding category defaults using normalized exact/plural aliases, not loose regex that accidentally includes totals. Merge stored choices over defaults; explicit false survives. Do not replace all defaults whenever any preference exists.

Defaults: Sales/Revenue and Net Profit in quarters/profit enabled, non-inverted. Shareholding FIIs/DIIs enabled non-inverted; Promoters/Public enabled inverted; ALL other rows (including shareholder count) configurable but disabled by default. Metric settings show grouped sections, aligned “Enable” and “Invert” columns with associated labels; include existing saved settings even if absent in current company, visibly unavailable rather than deleting preferences. Empty/no-data settings explains that rows appear when financials load; Theme always available. Replace “latest change” copy with “Each period compared with its previous period.”

Theme key `tradebaba:theme`, validated `dark` or `light`; default dark. Header toggle persists immediately and applies before painting when possible. All surfaces, menus, inputs, checkboxes, sticky cells, ratios, scrollbars and states use tokens; `color-scheme` matches chosen theme. Theme changes must not reset list/metric choices or scroll to latest again. Settings mode remains open when background stockData arrives: update cached current data without replacing the user's settings form.

## 9. States, accessibility, and completion checks

- Empty regular list: “No symbols in this list” + Add symbol. Empty filtered result: “No matching symbols” + clear search. Empty flag list explains flagging; no fake rows.
- Disconnected/no chart: keep local list usable; disable chart action with concise status, Retry available. Data fetch errors identify source and recovery; `role=status`/polite live region; error announced once, not on every polling tick.
- True button elements, named icon buttons, visible 2px focus ring, keyboard activation, menu focus management, adequate 28–32px minimum compact targets. No nested buttons. Table captions and `scope=col/row`; actual up/down accessible beyond color; no motion dependency.
- Test widths 360/480/720/1000px and both themes: two columns persist, settings usable, no body horizontal overflow, labels sticky, latest periods visible initially, keyboard controls reachable.

Runnable regression acceptance (extend `extension/test.mjs`, no new framework):
1. 7-period sequence `100,120,110,110,missing,130,140` → neutral, green, red, neutral, neutral, neutral, green (normal enabled metric). Confirm every rendered cell, not helper-only.
2. Same sequence inverted swaps only green/red; disabled all neutral. Test `0,-1,0`, Indian `₹ 1,23,456`, `%`, parenthesized negatives, Unicode minus, blanks/dashes/text; no skipped missing predecessor.
3. Descending headers and compact month names reorder correctly; Mar2026→Jun2026 exact comparison; TTM and growth windows neutral; trimmed view retains hidden predecessor.
4. FIIs/DIIs normal, Public/Promoters inverted with BOTH up and down periods; shareholder-count/other row disabled until explicitly enabled. Distinct quarter/profit keys; old preference migration; explicit false and invert persist through reload.
5. Dark/light persists and invalid storage falls back; metric/list settings survive theme changes. At least a DOM harness asserts actual classes, accessible comparison labels, settings row inclusion, and theme attribute—not only source regex.
6. List create/duplicate/rename/remove/clear, seed-once, independent membership, flags, sections/order reset, search/add duplicate prevention, persistence/corrupt storage, import validation/unresolved preview. No Dhan watchlist mutation messages emitted.
7. Fake delayed chart/Screener responses A→B: late A cannot replace B; errors don't falsely select requested stock; observer-driven identity works for stock selected outside extension. Existing crypto/bridge checks still pass.

Commands: `rtk proxy node extension/test.mjs`; `rtk proxy node --check extension/sidepanel.js` (and every modified JS file); `rtk git diff --check`. Optional HAR test only if user provides safe existing fixture; no profile/auth capture. Browser screenshots required for visual completion if browser becomes available: compare both themes to Dhan reference, exercise list menu, selection, financial horizontal scroll, settings. If unavailable, report unverified visual/live behavior rather than claim pass.

## 10. Luna execution handoff

Execute 4 → 5 → 6 → 7 → 8 → 9, reading ownership/root causes in 3 first. Commit is not requested. Keep implementation diff narrow but do not declare the full feature request complete with only Stage A cosmetics. Report Stage A done, Stage B verified or exact blocker, and each Stage C data/service dependency explicitly. No unnecessary scaffolding for Stage C and no inert toolbar buttons pretending those features work. Parent orchestrates execution and further feature decisions.
