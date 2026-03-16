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

  // "Fill All" — open portal in new tab and start sequential fill
  if (message.type === "CI_FILL_ALL") {
    handleFillAll(message.portal, message.college);
    return false;
  }

  // "Fill One Section" — open portal to specific section
  if (message.type === "CI_FILL_SECTION_FROM_CI") {
    handleFillSection(message.portal, message.section, message.college);
    return false;
  }

  return false;
});

// -- Fill All orchestration --

const PORTAL_URLS = {
  common_app: "https://apply.commonapp.org",
  uc_app: "https://apply.universityofcalifornia.edu",
};

async function handleFillAll(portal, college) {
  const baseUrl = PORTAL_URLS[portal];
  if (!baseUrl) return;

  const tab = await chrome.tabs.create({ url: `${baseUrl}/dashboard` });

  // Store fill-all intent for the content script to pick up
  await chrome.storage.local.set({
    ciFillAll: {
      portal,
      college,
      tabId: tab.id,
      startedAt: Date.now(),
    },
  });
}

async function handleFillSection(portal, section, college) {
  const baseUrl = PORTAL_URLS[portal];
  if (!baseUrl) return;

  // Fetch portal map to get section URL
  try {
    const map = await ciApiFetch(
      `agent/portal-map?portal=${encodeURIComponent(portal)}`,
    );
    const sectionConfig = map.sections?.[section];
    const sectionUrl = sectionConfig?.urlPattern
      ? `${baseUrl}${sectionConfig.urlPattern}`
      : `${baseUrl}/dashboard`;

    const tab = await chrome.tabs.create({ url: sectionUrl });

    await chrome.storage.local.set({
      ciFillSection: {
        portal,
        section,
        college,
        tabId: tab.id,
        startedAt: Date.now(),
      },
    });
  } catch {
    // Fallback: open dashboard
    await chrome.tabs.create({ url: `${baseUrl}/dashboard` });
  }
}

// -- Install/update lifecycle --

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    console.log(
      "[CI Extension] Installed — open CollegeInsight.ai to connect.",
    );
  }
});
