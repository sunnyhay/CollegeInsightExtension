/**
 * ci-bridge.js — Content script that runs on collegeinsight.ai.
 * Listens for CI_TOKEN_UPDATE messages from the CI web app and writes
 * the Firebase token to chrome.storage.local for the extension to use.
 */

window.addEventListener("message", (event) => {
  // Only accept messages from the CI origin
  if (event.origin !== window.location.origin) return;

  // Token bridge: CI web app sends Firebase token for extension to store
  if (event.data?.type === "CI_TOKEN_UPDATE") {
    const { token, expiry } = event.data;
    if (!token) return;
    chrome.storage.local.set({
      ciToken: token,
      ciTokenExpiry: expiry || Date.now() + 3600000,
    });
    return;
  }

  // Extension detection: CI web app pings to check if extension is installed
  if (event.data?.type === "CI_EXTENSION_PING") {
    window.postMessage(
      {
        type: "CI_EXTENSION_PONG",
        version: chrome.runtime.getManifest().version,
      },
      window.location.origin,
    );
    return;
  }

  // Fill All: CI web app requests the extension to fill an entire portal
  if (event.data?.type === "CI_FILL_ALL") {
    chrome.runtime.sendMessage({
      type: "CI_FILL_ALL",
      portal: event.data.portal,
      college: event.data.college,
    });
    return;
  }

  // Fill One Section: CI web app requests fill for a specific section
  if (event.data?.type === "CI_FILL_SECTION_FROM_CI") {
    chrome.runtime.sendMessage({
      type: "CI_FILL_SECTION_FROM_CI",
      portal: event.data.portal,
      section: event.data.section,
      college: event.data.college,
    });
    return;
  }

  // Common App API bridge: CI web app requests an api25 operation. The SW
  // forwards it to the apply.commonapp.org content script. Response is posted
  // back to the page so the SPA's Promise resolves. Each request carries a
  // requestId for correlation. See POC #5 / common-app-broker.js.
  //
  // Phase 1 #1.7: forward the per-session correlation nonce to the SW so it
  // can validate against the registered tab nonce before forwarding to the
  // broker. The Accelerator page mints the nonce on mount and registers it
  // via CI_REGISTER_NONCE_FROM_CI below.
  if (event.data?.type && event.data.type.startsWith("CI_CA_")) {
    const { type, requestId, ...payload } = event.data;
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      window.postMessage(
        {
          type: "CI_CA_RESPONSE",
          requestId,
          response: response || { success: false, error: "no_response" },
        },
        window.location.origin,
      );
    });
    return;
  }

  // Accelerator page registers its per-session nonce with the SW (Phase 1 #1.7).
  // The SW associates the nonce with this tab; subsequent CI_CA_* messages
  // from the same tab must carry the same nonce.
  if (event.data?.type === "CI_REGISTER_NONCE_FROM_CI") {
    chrome.runtime.sendMessage(
      { type: "CI_REGISTER_NONCE", nonce: event.data.nonce },
      (response) => {
        window.postMessage(
          {
            type: "CI_REGISTER_NONCE_ACK",
            success: !!response?.success,
          },
          window.location.origin,
        );
      },
    );
    return;
  }
});

// Periodically refresh: request a fresh token from the page every 45 min
setInterval(
  () => {
    window.postMessage({ type: "CI_TOKEN_REQUEST" }, window.location.origin);
  },
  45 * 60 * 1000,
);

// -- Opportunity A (push-based connection events) --
//
// The service worker pushes `CI_CA_CONNECTION_STATE` frames whenever the
// Common App broker reports a session-state change (connected /
// disconnected / expired). We forward them to the SPA as a same-origin
// window.postMessage so commonAppBridge's listeners can fire instantly
// instead of waiting for the next 5-second poll.
chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== "string") return undefined;
  if (message.type === "CI_CA_CONNECTION_STATE") {
    window.postMessage(
      {
        type: "CI_CA_CONNECTION_STATE",
        state: message.state,
        portal: message.portal,
        meta: message.meta || null,
      },
      window.location.origin,
    );
  }
  // No async response — return falsy so the SW knows we're not handling.
  return undefined;
});
