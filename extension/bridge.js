// Isolated-world relay. main.js runs in the MAIN world so it can read the
// TradingView widget, but only an isolated content script can talk to the
// background worker. This does nothing else.

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.__dhanWL !== "request") return;

  chrome.runtime.sendMessage(
    { type: "screener", symbol: msg.symbol },
    (res) => {
      const failed = chrome.runtime.lastError;
      window.postMessage(
        {
          __dhanWL: "response",
          id: msg.id,
          html: res && res.html,
          name: res && res.name,
          error: failed ? failed.message : res && res.error,
        },
        window.location.origin
      );
    }
  );
});
