// Isolated-world relay. main.js runs in the MAIN world so it can read the
// TradingView widget, but only an isolated content script can talk to the
// background worker. This does nothing else.

const ORPHANED = "extension was reloaded - refresh the page";

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
      { type: "screener", symbol: msg.symbol },
      (res) => {
        const failed = chrome.runtime.lastError;
        reply({
          html: res && res.html,
          name: res && res.name,
          error: failed ? failed.message : res && res.error,
        });
      }
    );
  } catch (err) {
    reply({ error: ORPHANED });
  }
});
