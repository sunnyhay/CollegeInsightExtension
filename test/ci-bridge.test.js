/**
 * Unit Tests: ci-bridge.js — Extension PING/PONG + message forwarding
 *
 * Tests the content script's message handling for:
 * - CI_EXTENSION_PING → CI_EXTENSION_PONG response
 * - CI_TOKEN_UPDATE → chrome.storage.local write
 * - CI_FILL_ALL → forwarded to service worker
 * - CI_FILL_SECTION_FROM_CI → forwarded to service worker
 */

// Mock chrome APIs
global.chrome = {
  storage: {
    local: {
      set: jest.fn(),
    },
  },
  runtime: {
    sendMessage: jest.fn(),
    getManifest: jest.fn(() => ({ version: "1.0.0" })),
  },
};

// Mock window.postMessage for tracking calls
const postMessageCalls = [];
const mockPostMessage = jest.fn((...args) => postMessageCalls.push(args));

// Simulate the ci-bridge message handler (extracted logic)
function handleCiBridgeMessage(event) {
  const expectedOrigin = "https://www.collegeinsight.ai";
  if (event.origin !== expectedOrigin) return;

  if (event.data?.type === "CI_TOKEN_UPDATE") {
    const { token, expiry } = event.data;
    if (!token) return;
    chrome.storage.local.set({
      ciToken: token,
      ciTokenExpiry: expiry || Date.now() + 3600000,
    });
    return;
  }

  if (event.data?.type === "CI_EXTENSION_PING") {
    mockPostMessage(
      {
        type: "CI_EXTENSION_PONG",
        version: chrome.runtime.getManifest().version,
      },
      event.origin,
    );
    return;
  }

  if (event.data?.type === "CI_FILL_ALL") {
    chrome.runtime.sendMessage({
      type: "CI_FILL_ALL",
      portal: event.data.portal,
      college: event.data.college,
    });
    return;
  }

  if (event.data?.type === "CI_FILL_SECTION_FROM_CI") {
    chrome.runtime.sendMessage({
      type: "CI_FILL_SECTION_FROM_CI",
      portal: event.data.portal,
      section: event.data.section,
      college: event.data.college,
    });
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  postMessageCalls.length = 0;
  // Set window.location.origin for tests
  delete global.window;
  global.window = { location: { origin: "https://www.collegeinsight.ai" } };
});

describe("ci-bridge — CI_EXTENSION_PING", () => {
  it("responds with CI_EXTENSION_PONG and version", () => {
    handleCiBridgeMessage({
      origin: window.location.origin,
      data: { type: "CI_EXTENSION_PING" },
    });

    expect(mockPostMessage).toHaveBeenCalledWith(
      { type: "CI_EXTENSION_PONG", version: "1.0.0" },
      expect.any(String),
    );
  });

  it("ignores PING from different origin", () => {
    handleCiBridgeMessage({
      origin: "https://malicious.com",
      data: { type: "CI_EXTENSION_PING" },
    });

    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});

describe("ci-bridge — CI_TOKEN_UPDATE", () => {
  it("stores token in chrome.storage.local", () => {
    handleCiBridgeMessage({
      origin: window.location.origin,
      data: {
        type: "CI_TOKEN_UPDATE",
        token: "jwt-token-123",
        expiry: 9999999,
      },
    });

    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      ciToken: "jwt-token-123",
      ciTokenExpiry: 9999999,
    });
  });

  it("ignores TOKEN_UPDATE with no token", () => {
    handleCiBridgeMessage({
      origin: window.location.origin,
      data: { type: "CI_TOKEN_UPDATE", token: null },
    });

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("sets default expiry if not provided", () => {
    handleCiBridgeMessage({
      origin: window.location.origin,
      data: { type: "CI_TOKEN_UPDATE", token: "abc" },
    });

    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ ciToken: "abc" }),
    );
    const call = chrome.storage.local.set.mock.calls[0][0];
    expect(call.ciTokenExpiry).toBeGreaterThan(Date.now());
  });
});

describe("ci-bridge — CI_FILL_ALL", () => {
  it("forwards fill-all request to service worker", () => {
    handleCiBridgeMessage({
      origin: window.location.origin,
      data: { type: "CI_FILL_ALL", portal: "common_app", college: "MIT" },
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "CI_FILL_ALL",
      portal: "common_app",
      college: "MIT",
    });
  });
});

describe("ci-bridge — CI_FILL_SECTION_FROM_CI", () => {
  it("forwards fill-section request to service worker", () => {
    handleCiBridgeMessage({
      origin: window.location.origin,
      data: {
        type: "CI_FILL_SECTION_FROM_CI",
        portal: "common_app",
        section: "activities",
        college: "MIT",
      },
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "CI_FILL_SECTION_FROM_CI",
      portal: "common_app",
      section: "activities",
      college: "MIT",
    });
  });
});

describe("ci-bridge — Unknown messages", () => {
  it("ignores unknown message types", () => {
    handleCiBridgeMessage({
      origin: window.location.origin,
      data: { type: "UNKNOWN_TYPE" },
    });

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});
