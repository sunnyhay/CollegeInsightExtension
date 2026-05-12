/**
 * common-app-broker.test.js — focused regression for the Phase 8 follow-up
 * `agent.ca.fill` A/B parity payload.
 *
 * The broker emits `agent.ca.fill` from its `chrome.runtime.onMessage`
 * handler when the SW forwards a `CA_*` operation. After the Phase 8
 * follow-up, the event MUST carry:
 *   - `messageType` (e.g. "CA_SAVE_ANSWERS")
 *   - For CA_SAVE_ANSWERS specifically: `section`, `collegeUnitid`,
 *     `filledCount`, `flaggedCount` — so dashboards can A/B-join against
 *     legacy `agent.fill.completed { portal, section, filledCount,
 *     flaggedCount }`.
 *
 * The broker is loaded as an IIFE on `apply.commonapp.org`. We boot it
 * in a `vm.createContext` sandbox the same way `service-worker.test.js`
 * boots the SW, capture the `chrome.runtime.onMessage` listener it
 * registers, drive a synthetic `CA_SAVE_ANSWERS` message at it, and
 * assert the captured `agent.ca.fill` envelope shape.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");

const BROKER_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../src/content/common-app-broker.js"),
  "utf8",
);

/**
 * Boot the broker IIFE in a fresh sandbox. Returns the captured listener
 * + a `getEvents()` helper that returns all telemetry envelopes the
 * broker tried to forward via `chrome.runtime.sendMessage`.
 */
function bootBroker({
  apiResponse = { validAnswers: [{ questionId: 1 }], invalidAnswers: [] },
  apiKey = "test-api-key",
  storedSession = null,
} = {}) {
  const events = [];
  let listener = null;

  // Mock fetch so the broker's api25 + Cognito requests resolve cleanly.
  // The broker's `caApi` calls `resp.text()` then attempts `JSON.parse`,
  // so both `text()` and `json()` need to be present.
  const fetchImpl = jest.fn(async (url) => {
    if (typeof url === "string" && url.includes("cognito-idp")) {
      // InitiateAuth refresh: return a fresh idToken envelope.
      const cog = { AuthenticationResult: { IdToken: "fresh-id-token" } };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(cog),
        json: async () => cog,
      };
    }
    // api25 endpoints (e.g. /answer/v2 for save_answers).
    return {
      ok: true,
      status: 200,
      text: async () =>
        apiResponse === undefined ? "" : JSON.stringify(apiResponse),
      json: async () => apiResponse,
    };
  });

  const sandboxLocalStorage = {
    _data: storedSession || {},
    getItem(k) {
      return this._data[k] ?? null;
    },
    setItem(k, v) {
      this._data[k] = String(v);
    },
    removeItem(k) {
      delete this._data[k];
    },
  };

  // Provide a window.__ciApiKeyExtractor stub so the broker doesn't
  // fail closed on every request.
  const sandboxWindow = {
    __ciApiKeyExtractor: {
      resolveApiKey: jest.fn(async () => ({
        key: apiKey,
        extractionFailed: false,
      })),
    },
    location: { hostname: "apply.commonapp.org" },
    localStorage: sandboxLocalStorage,
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout,
    clearTimeout,
  };

  const sandboxChrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => {
          listener = fn;
        },
      },
      sendMessage: jest.fn((msg) => {
        if (msg && msg.type === "AGENT_TELEMETRY") {
          events.push({ name: msg.name, properties: msg.props || {} });
        }
      }),
      lastError: null,
    },
  };

  const sandbox = {
    window: sandboxWindow,
    chrome: sandboxChrome,
    localStorage: sandboxLocalStorage,
    fetch: fetchImpl,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    crypto: { randomUUID: () => "test-uuid" },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    Promise,
    Date,
    Map,
    Set,
    JSON,
    Math,
    Buffer,
    URL,
    URLSearchParams,
    AbortController,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Error,
    TypeError,
    console: { log: () => {}, warn: () => {}, error: () => {} },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(BROKER_SOURCE, sandbox);

  if (!listener) {
    throw new Error("Broker did not register an onMessage listener");
  }
  return { listener, getEvents: () => events.slice() };
}

/** Drive the broker listener; resolves with the response sent. */
function callListener(listener, message) {
  return new Promise((resolve) => {
    let resolved = false;
    const sendResponse = (resp) => {
      if (resolved) return;
      resolved = true;
      resolve(resp);
    };
    const isAsync = listener(message, undefined, sendResponse);
    if (isAsync !== true && !resolved) {
      setImmediate(() => resolve(undefined));
    }
  });
}

// Cognito session triple required for `CA_SAVE_ANSWERS` (broker reads it
// from localStorage at message-handle time via getFreshIdToken).
const FAKE_SESSION = {
  "CognitoIdentityServiceProvider.7nlsd88gsm2rlvu45jv7g8edh8.LastAuthUser":
    "u1",
  "CognitoIdentityServiceProvider.7nlsd88gsm2rlvu45jv7g8edh8.u1.refreshToken":
    "rt",
  "CognitoIdentityServiceProvider.7nlsd88gsm2rlvu45jv7g8edh8.u1.deviceKey":
    "dk",
  // No idToken on file → forces a Cognito refresh on first call (mocked).
};

describe("common-app-broker — Phase 8 follow-up agent.ca.fill A/B parity", () => {
  it("CA_SAVE_ANSWERS success emits agent.ca.fill with messageType + section + collegeUnitid + filledCount + flaggedCount", async () => {
    const { listener, getEvents } = bootBroker({
      apiResponse: {
        validAnswers: [{ questionId: 1 }, { questionId: 2 }],
        invalidAnswers: [{ questionId: 3, reason: "format" }],
      },
      storedSession: FAKE_SESSION,
    });
    const resp = await callListener(listener, {
      type: "CA_SAVE_ANSWERS",
      answers: [
        { questionId: 1, response: "x" },
        { questionId: 2, response: "y" },
        { questionId: 3, response: "z" },
      ],
      // Phase 8 follow-up: SPA threads these through the SW envelope.
      section: "profile",
      collegeUnitid: "243744",
    });
    expect(resp.success).toBe(true);

    const fills = getEvents().filter((e) => e.name === "agent.ca.fill");
    expect(fills).toHaveLength(1);
    expect(fills[0].properties).toMatchObject({
      op: "save_answers",
      messageType: "CA_SAVE_ANSWERS",
      success: true,
      section: "profile",
      collegeUnitid: "243744",
      answerCount: 3,
      filledCount: 2,
      flaggedCount: 1,
    });
    expect(typeof fills[0].properties.durationMs).toBe("number");
  });

  it("CA_SAVE_ANSWERS failure also carries the A/B parity dimensions on the failure event", async () => {
    // Force a fetch error on the api25 call so saveAnswers throws.
    const { listener, getEvents } = bootBroker({
      apiResponse: undefined,
      storedSession: FAKE_SESSION,
    });
    // Override fetch on the broker context AFTER boot is awkward; instead
    // simulate failure by invalidating the ApiKey extractor result.
    // Easier: call the listener with a malformed request that throws in
    // the saveAnswers path. We push a CA_SAVE_ANSWERS with answers=null,
    // which triggers a TypeError inside the broker's mapping.
    const resp = await callListener(listener, {
      type: "CA_SAVE_ANSWERS",
      answers: null,
      section: "writing",
      collegeUnitid: "166683",
    });
    expect(resp.success).toBe(false);

    const fills = getEvents().filter((e) => e.name === "agent.ca.fill");
    // Most recent fill should be the failure.
    const fail = fills[fills.length - 1];
    expect(fail.properties).toMatchObject({
      op: "save_answers",
      messageType: "CA_SAVE_ANSWERS",
      success: false,
      section: "writing",
      collegeUnitid: "166683",
    });
    expect(typeof fail.properties.errorCode).toBe("string");
    expect(typeof fail.properties.durationMs).toBe("number");
  });

  it("non-save operations carry messageType but no section/collegeUnitid (those dimensions are CA_SAVE_ANSWERS only)", async () => {
    const { listener, getEvents } = bootBroker({
      storedSession: FAKE_SESSION,
      apiResponse: { colleges: [] },
    });
    const resp = await callListener(listener, { type: "CA_LIST_COLLEGES" });
    expect(resp.success).toBe(true);
    const fills = getEvents().filter((e) => e.name === "agent.ca.fill");
    expect(fills).toHaveLength(1);
    expect(fills[0].properties).toMatchObject({
      op: "list_colleges",
      messageType: "CA_LIST_COLLEGES",
      success: true,
    });
    expect(fills[0].properties.section).toBeUndefined();
    expect(fills[0].properties.collegeUnitid).toBeUndefined();
    expect(fills[0].properties.filledCount).toBeUndefined();
  });

  it("Phase 4 #21: conditional-phase invalidAnswers surface as skippedCount, not flaggedCount", async () => {
    // The Stage 3 conditional follow-up batch tags its envelope with
    // `phase: "conditional"`. api25's invalidAnswers in that case mean
    // "the parent didn't trigger the child for this user", not a save
    // failure. The broker must record those as `skippedCount` so
    // dashboards' failure-rate signal stays clean.
    const { listener, getEvents } = bootBroker({
      apiResponse: {
        validAnswers: [{ questionId: 7 }],
        invalidAnswers: [{ questionId: 8, reason: "not_triggered" }],
      },
      storedSession: FAKE_SESSION,
    });
    const resp = await callListener(listener, {
      type: "CA_SAVE_ANSWERS",
      answers: [
        { questionId: 7, response: "x" },
        { questionId: 8, response: "y" },
      ],
      section: "profile",
      collegeUnitid: "243744",
      phase: "conditional",
    });
    expect(resp.success).toBe(true);
    const fills = getEvents().filter((e) => e.name === "agent.ca.fill");
    expect(fills).toHaveLength(1);
    expect(fills[0].properties).toMatchObject({
      op: "save_answers",
      messageType: "CA_SAVE_ANSWERS",
      success: true,
      phase: "conditional",
      filledCount: 1,
      // Conditional phase: invalidAnswers → skippedCount, NOT flaggedCount.
      flaggedCount: 0,
      skippedCount: 1,
    });
  });

  it("Phase 4 #21: visible-phase invalidAnswers still surface as flaggedCount", async () => {
    // Sanity: the conditional carve-out only applies when `phase: "conditional"`.
    // Visible-phase invalidAnswers remain real save failures.
    const { listener, getEvents } = bootBroker({
      apiResponse: {
        validAnswers: [{ questionId: 7 }],
        invalidAnswers: [{ questionId: 8, reason: "format" }],
      },
      storedSession: FAKE_SESSION,
    });
    await callListener(listener, {
      type: "CA_SAVE_ANSWERS",
      answers: [
        { questionId: 7, response: "x" },
        { questionId: 8, response: "y" },
      ],
      section: "profile",
      collegeUnitid: "243744",
      phase: "visible",
    });
    const fills = getEvents().filter((e) => e.name === "agent.ca.fill");
    expect(fills[0].properties).toMatchObject({
      phase: "visible",
      filledCount: 1,
      flaggedCount: 1,
      skippedCount: 0,
    });
  });
});
