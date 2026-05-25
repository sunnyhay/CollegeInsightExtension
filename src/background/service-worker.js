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
// Caches Compass API responses per session to avoid redundant calls.
// Compass data (profile, activities) reused across Fill All sections.
// Portal maps cached for 7 days in chrome.storage.local.

const sessionCache = new Map(); // key → { data, timestamp }
const SESSION_CACHE_TTL = 300000; // 5 minutes for Compass data
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

// -- Per-tab correlation nonce for CI_CA_* gating (Phase 1 #1.7) --
// The Accelerator page mints a random nonce on mount and registers it via
// CI_REGISTER_NONCE. Every subsequent CI_CA_* message (except CI_CA_PING)
// must carry that same nonce or the SW rejects it. Stops arbitrary
// same-origin scripts (other extensions, dev console, page-injected) from
// invoking the Common App broker.
const tabNonces = new Map(); // tabId → { nonce, registeredAt }
const NONCE_TTL_MS = 8 * 60 * 60 * 1000; // 8h — covers a long fill session
const CI_CA_AUTH_FREE = new Set(["CI_CA_PING"]);

// Opportunity A (§8.0.11) — push connection-state events to subscribed
// SPA tabs. We treat the tabNonces registry as the canonical "subscribed
// SPA tabs" set: a tab that registered a nonce is, by definition, an
// Accelerator page that wants to receive push events.
//
// `pendingPushQueue` covers the race where the broker fires
// `CA_CONNECTION_STATE` between extension wake and the SPA's first
// nonce registration — we hold the most recent event for 5 s and flush
// it on the next nonce registration.
const pendingPushQueue = []; // { evt, expiresAt }
const PENDING_PUSH_TTL_MS = 5000;

function pushQueueAdd(evt) {
  pendingPushQueue.push({ evt, expiresAt: Date.now() + PENDING_PUSH_TTL_MS });
  // Bound the queue — drop oldest if we somehow accumulate.
  while (pendingPushQueue.length > 4) pendingPushQueue.shift();
}

function pushQueueFlushTo(tabId) {
  const now = Date.now();
  while (pendingPushQueue.length > 0 && pendingPushQueue[0].expiresAt < now) {
    pendingPushQueue.shift();
  }
  for (const { evt } of pendingPushQueue) {
    sendPushToTab(tabId, evt);
  }
}

function sendPushToTab(tabId, evt) {
  try {
    chrome.tabs.sendMessage(tabId, evt, () => {
      // Swallow lastError — a tab may be closed mid-flight.
      void chrome.runtime.lastError;
    });
  } catch (e) {
    // ignore
  }
}

function broadcastConnectionState(state, portal, meta) {
  const evt = {
    type: "CI_CA_CONNECTION_STATE",
    state,
    portal,
    meta: meta || null,
  };
  const subscribedCount = tabNonces.size;
  if (subscribedCount === 0) {
    pushQueueAdd(evt);
    swTrackEvent("agent.ca.state_pushed", {
      state,
      portal,
      subscribedTabCount: 0,
      queued: true,
    });
    return;
  }
  for (const tabId of tabNonces.keys()) {
    sendPushToTab(tabId, evt);
  }
  swTrackEvent("agent.ca.state_pushed", {
    state,
    portal,
    subscribedTabCount: subscribedCount,
    queued: false,
  });
}

// Tab cleanup — prune nonces when an Accelerator tab closes so the
// registry doesn't leak.
if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabNonces.delete(tabId);
  });
}

function registerNonce(tabId, nonce) {
  if (
    typeof tabId !== "number" ||
    typeof nonce !== "string" ||
    nonce.length < 16
  ) {
    return false;
  }
  tabNonces.set(tabId, { nonce, registeredAt: Date.now() });
  // Flush any queued push events to this tab.
  pushQueueFlushTo(tabId);
  return true;
}

function validateNonce(tabId, nonce) {
  const entry = tabNonces.get(tabId);
  if (!entry) return "no_nonce";
  if (Date.now() - entry.registeredAt > NONCE_TTL_MS) {
    tabNonces.delete(tabId);
    return "no_nonce";
  }
  if (!nonce || nonce !== entry.nonce) return "bad_nonce";
  return "ok";
}

// Promise-returning wallet probe (reuses CI_GET_MEMBER_STATUS cache).
// MB-5 task 2.13: in PAYG the bypass requires a positive point balance,
// not a premium-tier flag. Endpoint is unchanged (still returns `member`
// for legacy callers; `pointBalance` is the authoritative field now).
async function probePoints() {
  const cached = getCached("memberStatus");
  if (cached) return cached;
  try {
    const data = await ciApiFetch("user/memberStatus");
    const balance =
      typeof data?.pointBalance === "number" ? data.pointBalance : 0;
    const result = {
      hasPoints: balance > 0,
      pointBalance: balance,
      member: data?.member || 0,
    };
    setCache("memberStatus", result);
    return result;
  } catch (err) {
    swTrackEvent("agent.member_check.error", { error: err.message });
    return { hasPoints: false, pointBalance: 0, member: 0, error: err.message };
  }
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

  // 10-second timeout via AbortController
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  let resp;
  try {
    resp = await fetch(`${apiBase}/${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        correlationId: crypto.randomUUID(),
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      swTrackEvent("agent.api.timeout", { path });
      throw new Error("ci_error:timeout");
    }
    throw err;
  }
  clearTimeout(timeoutId);

  if (!resp.ok) {
    // Normalize error codes — never expose raw HTTP status to content scripts
    const errorType =
      resp.status === 401
        ? "auth_required"
        : resp.status === 429
          ? "rate_limited"
          : resp.status >= 500
            ? "service_error"
            : "request_error";
    swTrackEvent("agent.api.error", { path, status: String(resp.status) });
    throw new Error(`ci_error:${errorType}`);
  }
  return resp.json();
}

// -- Message handler —

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CI_GET_STATUS") {
    getToken().then((token) => {
      sendResponse({ authenticated: !!token });
    });
    return true; // async response
  }

  if (message.type === "CI_GET_MEMBER_STATUS") {
    const cacheKey = "memberStatus";
    const cached = getCached(cacheKey);
    if (cached) {
      sendResponse({ success: true, ...cached, cached: true });
      return true;
    }
    ciApiFetch("user/memberStatus")
      .then((data) => {
        const result = {
          isPremium: data?.member > 0,
          member: data?.member || 0,
        };
        setCache(cacheKey, result, 5 * 60 * 1000); // 5-min cache
        sendResponse({ success: true, ...result });
      })
      .catch((err) => {
        swTrackEvent("agent.member_check.error", { error: err.message });
        sendResponse({ success: false, isPremium: false, error: err.message });
      });
    return true;
  }

  if (message.type === "CI_FETCH_COMPASS") {
    const cacheKey = `compass:${message.endpoint}`;
    const cached = getCached(cacheKey);
    if (cached) {
      sendResponse({ success: true, data: cached, cached: true });
      return true;
    }
    ciApiFetch(`compass/${message.endpoint}`).then(
      (data) => {
        setCache(cacheKey, data);
        sendResponse({ success: true, data });
      },
      (err) => {
        swTrackEvent("agent.api.error", {
          endpoint: "compass",
          error: err.message,
        });
        sendResponse({ success: false, error: err.message });
      },
    );
    return true;
  }

  if (message.type === "CI_FETCH_ESSAY_PROMPTS") {
    const unitid = message.unitid;
    const cacheKey = `essayPrompts:${unitid}`;
    const cached = getCached(cacheKey);
    if (cached) {
      sendResponse({ success: true, data: cached, cached: true });
      return true;
    }
    ciApiFetch(`agent/essay-prompts/${unitid}`).then(
      (data) => {
        setCache(cacheKey, data);
        sendResponse({ success: true, data });
      },
      (err) => {
        swTrackEvent("agent.api.error", {
          endpoint: "essay-prompts",
          unitid,
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
    ciApiFetch("compass/status", {
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

  // Accelerator page registers a per-tab correlation nonce. Origin allowlist
  // is enforced by the manifest content_scripts.matches list — only those
  // origins can inject ci-bridge.js and reach this handler.
  if (message.type === "CI_REGISTER_NONCE") {
    const tabId = sender?.tab?.id;
    const ok = registerNonce(tabId, message.nonce);
    sendResponse({ success: ok });
    return false;
  }

  // Telemetry forwarder — content scripts (broker, extractor) can't talk to
  // App Insights directly without CSP juggling. They post AGENT_TELEMETRY
  // here and we relay through swTrackEvent.
  if (message.type === "AGENT_TELEMETRY" && typeof message.name === "string") {
    swTrackEvent(message.name, message.props || {});
    return false;
  }

  // --- Common App API broker bridge ---
  // The SPA (via ci-bridge.js) sends CI_CA_* messages here. We forward them as
  // CA_* messages to the apply.commonapp.org content script, which actually
  // performs the fetch (api25 enforces an Origin allowlist; the SW can't call
  // it directly). See POC #4 in scripts/common-app/notes.md §3c.
  //
  // Phase 1 #1.7: gate every non-ping CI_CA_* message on (a) a registered
  // per-tab nonce and (b) premium membership. Without these, a non-premium
  // user with the extension installed could post CI_CA_SAVE_ANSWERS directly
  // via window.postMessage and bypass the Accelerator UI gate.
  if (message.type && message.type.startsWith("CI_CA_")) {
    if (!CI_CA_AUTH_FREE.has(message.type)) {
      const tabId = sender?.tab?.id;
      const nonceCheck = validateNonce(tabId, message.nonce);
      if (nonceCheck !== "ok") {
        swTrackEvent("agent.ca.bypass_blocked", {
          code: nonceCheck,
          messageType: message.type,
        });
        sendResponse({ success: false, code: nonceCheck, error: nonceCheck });
        return false;
      }
      probePoints().then((status) => {
        if (!status.hasPoints) {
          swTrackEvent("agent.ca.bypass_blocked", {
            code: "no_points",
            messageType: message.type,
            pointBalance: status.pointBalance,
          });
          sendResponse({
            success: false,
            code: "insufficient_points",
            error: "insufficient_points",
          });
          return;
        }
        handleCommonAppBridge(message)
          .then((result) => sendResponse(result))
          .catch((err) =>
            sendResponse({
              success: false,
              error: String(err?.message || err),
            }),
          );
      });
      return true; // async
    }
    // CI_CA_PING is allowlisted — used as a connection probe before nonce/membership are known.
    handleCommonAppBridge(message)
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({ success: false, error: String(err?.message || err) }),
      );
    return true; // async
  }

  // Cache the most recent Common App session capture so the popup/SPA can show
  // "connected to Common App" status without round-tripping to the tab.
  // Note: the broker (common-app-broker.js) emits the canonical `agent.ca.capture`
  // event — we don't re-emit here to avoid duplicate / mis-shaped events.
  if (message.type === "CA_SESSION_CAPTURED") {
    chrome.storage.local.set({
      caSession: { ...message.meta, capturedAt: Date.now() },
    });
    return false;
  }

  // Opportunity A (§8.0.11) — broker fan-out. Broker emits state-machine
  // events (`connected` / `disconnected` / `expired`); we broadcast to
  // every SPA tab in the nonce registry.
  if (message.type === "CA_CONNECTION_STATE") {
    if (message.state === "connected") {
      // Mirror the legacy CA_SESSION_CAPTURED side-effect so popup/SPA
      // can read `caSession` from chrome.storage if needed.
      chrome.storage.local.set({
        caSession: { ...(message.meta || {}), capturedAt: Date.now() },
      });
    }
    broadcastConnectionState(
      message.state,
      message.portal || "common_app",
      message.meta,
    );
    return false;
  }

  return false;
});

// -- Common App bridge --

const CA_TAB_URL_MATCH = "https://apply.commonapp.org/*";

async function findCommonAppTab() {
  const tabs = await chrome.tabs.query({ url: CA_TAB_URL_MATCH });
  // Prefer the most recently active matching tab.
  return (
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] ||
    null
  );
}

async function handleCommonAppBridge(message) {
  const tab = await findCommonAppTab();
  if (!tab) {
    return {
      success: false,
      error: "ca_no_tab",
      hint: "Open https://apply.commonapp.org in a tab to enable Common App fills.",
    };
  }
  // Translate CI_CA_* → CA_* expected by the broker content script.
  const caMessage = {
    ...message,
    type: message.type.replace(/^CI_CA_/, "CA_"),
  };
  // Bridge-forward telemetry. Distinct event name from the broker's
  // `agent.ca.fill` so the documented broker schema (op/success/durationMs)
  // stays clean. This event records the SW → content-script hop only.
  swTrackEvent("agent.ca.bridge_forward", {
    messageType: caMessage.type,
    tabId: String(tab.id),
  });
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, caMessage, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({
          success: false,
          error: `ca_tab_unreachable:${chrome.runtime.lastError.message}`,
        });
        return;
      }
      resolve(resp || { success: false, error: "ca_no_response" });
    });
  });
}

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
