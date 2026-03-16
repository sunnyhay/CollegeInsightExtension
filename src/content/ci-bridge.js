/**
 * ci-bridge.js — Content script that runs on collegeinsight.ai.
 * Listens for CI_TOKEN_UPDATE messages from the CI web app and writes
 * the Firebase token to chrome.storage.local for the extension to use.
 */

window.addEventListener("message", (event) => {
  // Only accept messages from the CI origin
  if (event.origin !== window.location.origin) return;
  if (event.data?.type !== "CI_TOKEN_UPDATE") return;

  const { token, expiry } = event.data;
  if (!token) return;

  chrome.storage.local.set({
    ciToken: token,
    ciTokenExpiry: expiry || Date.now() + 3600000,
  });
});

// Periodically refresh: request a fresh token from the page every 45 min
setInterval(
  () => {
    window.postMessage({ type: "CI_TOKEN_REQUEST" }, window.location.origin);
  },
  45 * 60 * 1000,
);
