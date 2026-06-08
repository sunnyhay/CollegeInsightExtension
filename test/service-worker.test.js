/**
 * service-worker.test.js — regression coverage for the Phase 1 #1.7
 * security gate on `CI_CA_*` messages.
 *
 * The service worker MUST reject any non-`CI_CA_PING` message that is
 * missing or has a stale per-tab nonce, and MUST reject premium-required
 * commands when the user is not a paying member. Both branches emit
 * `agent.ca.bypass_blocked` telemetry. Without this gate, a non-premium
 * user (or any same-origin attacker on a CI page) could `postMessage`
 * `CI_CA_SAVE_ANSWERS` directly to the broker.
 *
 * Because the SW is loaded as a single global script (no `module.exports`),
 * we run it in a fresh `vm.createContext` sandbox and capture the
 * `chrome.runtime.onMessage` listener it registers. We then drive that
 * listener directly to assert the gate's behavior.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");

const SW_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../src/background/service-worker.js"),
  "utf8",
);

/**
 * Build a fresh sandbox + run the SW source. Returns the captured
 * `chrome.runtime.onMessage` listener and a `getEvents()` helper that
 * returns every telemetry event seen so far.
 */
function bootSW({
  memberStatus = { member: 1 },
  tabs = [{ id: 99, url: "https://apply.commonapp.org/dashboard" }],
} = {}) {
  const events = [];
  let listener = null;

  const fetchImpl = jest.fn(async (url, opts) => {
    if (
      typeof url === "string" &&
      url.includes("dc.services.visualstudio.com")
    ) {
      try {
        const body = JSON.parse(opts.body);
        events.push({
          name: body.data?.baseData?.name,
          properties: body.data?.baseData?.properties || {},
        });
      } catch {
        /* ignore */
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (typeof url === "string" && url.endsWith("/user/memberStatus")) {
      return { ok: true, status: 200, json: async () => memberStatus };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });

  const tabSendMessage = jest.fn((tabId, msg, cb) => {
    setImmediate(() => cb({ success: true, echoed: msg.type }));
  });

  const sandbox = {
    chrome: {
      runtime: {
        onMessage: {
          addListener: (fn) => {
            listener = fn;
          },
        },
        onInstalled: { addListener: () => {} },
        sendMessage: jest.fn(),
        lastError: null,
        getManifest: () => ({ version: "1.0.0-test" }),
        getURL: (p) => `chrome-extension://test/${p}`,
        id: "test-extension-id",
      },
      storage: {
        local: {
          get: (keys, cb) => {
            // MV3 supports both callback and promise forms. The SW awaits
            // the promise form in `getToken()` and uses the callback form
            // in CI_FETCH_PORTAL_MAP. Support both.
            const store = {
              ciToken: "test-firebase-token",
              ciTokenExpiry: Date.now() + 3600_000,
            };
            const list = Array.isArray(keys) ? keys : keys ? [keys] : [];
            const out = {};
            for (const k of list) if (k in store) out[k] = store[k];
            if (typeof cb === "function") {
              cb(out);
              return undefined;
            }
            return Promise.resolve(out);
          },
          set: (_v, cb) => {
            if (typeof cb === "function") cb();
            return Promise.resolve();
          },
          remove: (_k, cb) => {
            if (typeof cb === "function") cb();
            return Promise.resolve();
          },
        },
      },
      tabs: {
        query: (_q, cb) => {
          if (typeof cb === "function") {
            cb(tabs);
            return undefined;
          }
          return Promise.resolve(tabs);
        },
        sendMessage: tabSendMessage,
        create: jest.fn(),
        onUpdated: { addListener: () => {} },
        onRemoved: { addListener: () => {} },
      },
      action: { onClicked: { addListener: () => {} } },
    },
    fetch: fetchImpl,
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
    URL,
    URLSearchParams,
    AbortController,
    console: { log: () => {}, warn: () => {}, error: () => {} },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox);

  if (!listener) {
    throw new Error("SW did not register an onMessage listener");
  }
  return { listener, getEvents: () => events.slice(), tabSendMessage };
}

/** Drive the SW listener and resolve with the response sent. */
function callListener(listener, message, sender = { tab: { id: 1 } }) {
  return new Promise((resolve) => {
    let resolved = false;
    const sendResponse = (resp) => {
      if (resolved) return;
      resolved = true;
      resolve(resp);
    };
    const isAsync = listener(message, sender, sendResponse);
    if (isAsync !== true && !resolved) {
      setImmediate(() => resolve(undefined));
    }
  });
}

const VALID_NONCE = "0123456789abcdef0123456789abcdef"; // ≥16 chars

describe("service-worker — Phase 1 #1.7 CI_CA_* gate", () => {
  it("allows CI_CA_PING without nonce or membership (auth-free probe)", async () => {
    const { listener } = bootSW();
    const resp = await callListener(listener, { type: "CI_CA_PING" });
    expect(resp.success).toBe(true);
    expect(resp.echoed).toBe("CA_PING");
  });

  it("rejects CI_CA_LIST_COLLEGES with no_nonce when nonce is missing", async () => {
    const { listener, getEvents } = bootSW();
    const resp = await callListener(listener, { type: "CI_CA_LIST_COLLEGES" });
    expect(resp).toEqual({
      success: false,
      code: "no_nonce",
      error: "no_nonce",
    });
    const blocks = getEvents().filter(
      (e) => e.name === "agent.ca.bypass_blocked",
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].properties).toMatchObject({
      code: "no_nonce",
      messageType: "CI_CA_LIST_COLLEGES",
    });
  });

  it("rejects CI_CA_SAVE_ANSWERS with bad_nonce when nonce mismatches", async () => {
    const { listener, getEvents } = bootSW();
    const reg = await callListener(
      listener,
      { type: "CI_REGISTER_NONCE", nonce: VALID_NONCE },
      { tab: { id: 7 } },
    );
    expect(reg).toEqual({ success: true });

    const resp = await callListener(
      listener,
      { type: "CI_CA_SAVE_ANSWERS", nonce: "wrong-nonce-and-long-enough" },
      { tab: { id: 7 } },
    );
    expect(resp).toEqual({
      success: false,
      code: "bad_nonce",
      error: "bad_nonce",
    });
    const blocks = getEvents().filter(
      (e) => e.name === "agent.ca.bypass_blocked",
    );
    expect(blocks.some((e) => e.properties.code === "bad_nonce")).toBe(true);
  });

  it("rejects CI_CA_LIST_COLLEGES with no_nonce when sent from a tab that never registered", async () => {
    const { listener, getEvents } = bootSW();
    await callListener(
      listener,
      { type: "CI_REGISTER_NONCE", nonce: VALID_NONCE },
      { tab: { id: 1 } },
    );
    const resp = await callListener(
      listener,
      { type: "CI_CA_LIST_COLLEGES", nonce: VALID_NONCE },
      { tab: { id: 999 } },
    );
    expect(resp.code).toBe("no_nonce");
    const blocks = getEvents().filter(
      (e) => e.name === "agent.ca.bypass_blocked",
    );
    expect(blocks.some((e) => e.properties.code === "no_nonce")).toBe(true);
  });

  it("rejects CI_REGISTER_NONCE when nonce is shorter than 16 chars", async () => {
    const { listener } = bootSW();
    const resp = await callListener(
      listener,
      { type: "CI_REGISTER_NONCE", nonce: "tiny" },
      { tab: { id: 1 } },
    );
    expect(resp).toEqual({ success: false });
  });

  it("rejects CI_REGISTER_NONCE when sender has no tab id", async () => {
    const { listener } = bootSW();
    const resp = await callListener(
      listener,
      { type: "CI_REGISTER_NONCE", nonce: VALID_NONCE },
      {},
    );
    expect(resp).toEqual({ success: false });
  });

  it("forwards valid-nonce calls regardless of membership (premium gate removed)", async () => {
    const { listener, tabSendMessage } = bootSW({
      memberStatus: { member: 0 },
    });
    await callListener(
      listener,
      { type: "CI_REGISTER_NONCE", nonce: VALID_NONCE },
      { tab: { id: 5 } },
    );
    const resp = await callListener(
      listener,
      { type: "CI_CA_SAVE_ANSWERS", nonce: VALID_NONCE },
      { tab: { id: 5 } },
    );
    expect(resp.success).toBe(true);
    expect(tabSendMessage).toHaveBeenCalledTimes(1);
  });

  it("forwards valid-nonce premium calls to the Common App tab via chrome.tabs.sendMessage", async () => {
    const { listener, tabSendMessage } = bootSW({
      memberStatus: { member: 2 },
    });
    await callListener(
      listener,
      { type: "CI_REGISTER_NONCE", nonce: VALID_NONCE },
      { tab: { id: 8 } },
    );
    const resp = await callListener(
      listener,
      {
        type: "CI_CA_LIST_COLLEGES",
        nonce: VALID_NONCE,
        somePayload: "x",
      },
      { tab: { id: 8 } },
    );
    expect(tabSendMessage).toHaveBeenCalledTimes(1);
    const [tabId, forwardedMsg] = tabSendMessage.mock.calls[0];
    expect(tabId).toBe(99);
    expect(forwardedMsg.type).toBe("CA_LIST_COLLEGES");
    expect(forwardedMsg.somePayload).toBe("x");
    expect(resp.success).toBe(true);
  });

  it("returns ca_no_tab when no Common App tab is open (premium + valid nonce)", async () => {
    const { listener, tabSendMessage } = bootSW({
      memberStatus: { member: 1 },
      tabs: [],
    });
    await callListener(
      listener,
      { type: "CI_REGISTER_NONCE", nonce: VALID_NONCE },
      { tab: { id: 3 } },
    );
    const resp = await callListener(
      listener,
      { type: "CI_CA_LIST_COLLEGES", nonce: VALID_NONCE },
      { tab: { id: 3 } },
    );
    expect(tabSendMessage).not.toHaveBeenCalled();
    expect(resp.success).toBe(false);
    expect(resp.error).toBe("ca_no_tab");
  });
});
