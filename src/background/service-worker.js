/**
 * Service Worker — background script for the CollegeInsight extension.
 * Manages auth tokens, CI API calls, and coordinates content scripts.
 */

const CI_API_BASE = "https://api.collegeinsight.ai";

// -- Token management --

async function getToken() {
  const data = await chrome.storage.local.get(["ciToken", "ciTokenExpiry"]);
  if (!data.ciToken) return null;
  if (data.ciTokenExpiry && Date.now() > data.ciTokenExpiry) return null;
  return data.ciToken;
}

async function ciApiFetch(path, options = {}) {
  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated — open CollegeInsight to sign in");
  }
  const resp = await fetch(`${CI_API_BASE}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      correlationId: crypto.randomUUID(),
      ...(options.headers || {}),
    },
  });
  if (!resp.ok) {
    throw new Error(`CI API error: ${resp.status} ${resp.statusText}`);
  }
  return resp.json();
}

// -- Message handler —

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "CI_GET_STATUS") {
    getToken().then((token) => {
      sendResponse({ authenticated: !!token });
    });
    return true; // async response
  }

  if (message.type === "CI_FETCH_TWIN") {
    ciApiFetch(`twin/${message.endpoint}`).then(
      (data) => sendResponse({ success: true, data }),
      (err) => sendResponse({ success: false, error: err.message }),
    );
    return true;
  }

  if (message.type === "CI_FETCH_PORTAL_MAP") {
    ciApiFetch(
      `agent/portal-map?portal=${encodeURIComponent(message.portal)}`,
    ).then(
      (data) => sendResponse({ success: true, data }),
      (err) => sendResponse({ success: false, error: err.message }),
    );
    return true;
  }

  if (message.type === "CI_POST_STATUS") {
    ciApiFetch("twin/status", {
      method: "POST",
      body: JSON.stringify(message.payload),
    }).then(
      (data) => sendResponse({ success: true, data }),
      (err) => sendResponse({ success: false, error: err.message }),
    );
    return true;
  }

  if (message.type === "CI_AI_MAP") {
    ciApiFetch("agent/ai-map", {
      method: "POST",
      body: JSON.stringify({
        portalDomain: message.portalDomain,
        fields: message.fields,
      }),
    }).then(
      (data) => sendResponse({ success: true, data }),
      (err) => sendResponse({ success: false, error: err.message }),
    );
    return true;
  }

  return false;
});

// -- Install/update lifecycle --

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    console.log(
      "[CI Extension] Installed — open CollegeInsight.ai to connect.",
    );
  }
});
