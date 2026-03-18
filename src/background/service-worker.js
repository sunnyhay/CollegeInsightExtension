/**
 * Service Worker — background script for the CollegeInsight extension.
 * Manages auth tokens, CI API calls, session caching, and coordinates content scripts.
 */

const CI_API_BASE_DEFAULT = "https://api.collegeinsight.ai";
const AI_ENDPOINT = "https://dc.services.visualstudio.com/v2/track";
const AI_IKEY = "0f2a4e7d-8b3c-4d1e-9f5a-6c7b8d9e0f1a";

/** Lightweight telemetry for the service worker (no window access). */
function swTrackEvent(name, properties = {}) {
  const envelope = {
    name: "Microsoft.ApplicationInsights.Event",
    time: new Date().toISOString(),
    iKey: AI_IKEY,
    data: {
      baseType: "EventData",
      baseData: {
        ver: 2,
        name,
        properties: {
          agentType: "extension",
          context: "service_worker",
          ...properties,
        },
      },
    },
  };
  fetch(AI_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
    keepalive: true,
  }).catch(() => {});
}

// Allow API base override via chrome.storage for local/dev testing.
// Production users never set this — they always use the default.
let CI_API_BASE = CI_API_BASE_DEFAULT;
chrome.storage.local.get(["ciApiBase"], (data) => {
  if (data.ciApiBase) CI_API_BASE = data.ciApiBase;
});

// -- Session Cache --
// Caches Twin API responses per session to avoid redundant calls.
// Twin data (profile, activities) reused across Fill All sections.
// Portal maps cached for 7 days in chrome.storage.local.

const sessionCache = new Map(); // key → { data, timestamp }
const SESSION_CACHE_TTL = 300000; // 5 minutes for Twin data
const PORTAL_MAP_TTL = 604800000; // 7 days for portal maps

function getCached(key) {
  const entry = sessionCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > SESSION_CACHE_TTL) {
    sessionCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  sessionCache.set(key, { data, timestamp: Date.now() });
}

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
  // Re-read API base on each call (picks up dev/test overrides set via chrome.storage)
  const stored = await chrome.storage.local.get(["ciApiBase"]);
  const apiBase = stored.ciApiBase || CI_API_BASE;
  const resp = await fetch(`${apiBase}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      correlationId: crypto.randomUUID(),
      ...(options.headers || {}),
    },
  });
  if (!resp.ok) {
    const err = `CI API error: ${resp.status} ${resp.statusText}`;
    swTrackEvent("agent.api.error", { path, status: String(resp.status) });
    throw new Error(err);
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
    const cacheKey = `twin:${message.endpoint}`;
    const cached = getCached(cacheKey);
    if (cached) {
      sendResponse({ success: true, data: cached, cached: true });
      return true;
    }
    ciApiFetch(`twin/${message.endpoint}`).then(
      (data) => {
        setCache(cacheKey, data);
        sendResponse({ success: true, data });
      },
      (err) => {
        swTrackEvent("agent.api.error", {
          endpoint: "twin",
          error: err.message,
        });
        sendResponse({ success: false, error: err.message });
      },
    );
    return true;
  }

  if (message.type === "CI_FETCH_PORTAL_MAP") {
    // Portal maps use long-term cache (7 days via chrome.storage)
    const storageKey = `portalMap:${message.portal}`;
    chrome.storage.local.get([storageKey], (stored) => {
      const entry = stored[storageKey];
      if (entry && Date.now() - entry.timestamp < PORTAL_MAP_TTL) {
        sendResponse({ success: true, data: entry.data, cached: true });
        return;
      }
      ciApiFetch(
        `agent/portal-map?portal=${encodeURIComponent(message.portal)}`,
      ).then(
        (data) => {
          chrome.storage.local.set({
            [storageKey]: { data, timestamp: Date.now() },
          });
          sendResponse({ success: true, data });
        },
        (err) => {
          swTrackEvent("agent.api.error", {
            endpoint: "portal-map",
            portal: message.portal,
            error: err.message,
          });
          sendResponse({ success: false, error: err.message });
        },
      );
    });
    return true;
  }

  if (message.type === "CI_POST_STATUS") {
    ciApiFetch("twin/status", {
      method: "POST",
      body: JSON.stringify(message.payload),
    }).then(
      (data) => sendResponse({ success: true, data }),
      (err) => {
        swTrackEvent("agent.api.error", {
          endpoint: "status",
          error: err.message,
        });
        sendResponse({ success: false, error: err.message });
      },
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
      (err) => {
        swTrackEvent("agent.api.error", {
          endpoint: "ai-map",
          error: err.message,
        });
        sendResponse({ success: false, error: err.message });
      },
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
  } catch (err) {
    swTrackEvent("agent.fill_section.error", {
      portal,
      section,
      error: err?.message,
    });
    // Fallback: open dashboard
    await chrome.tabs.create({ url: `${baseUrl}/dashboard` });
  }
}

// -- Install/update lifecycle --

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    swTrackEvent("agent.installed");
  }
});
