/**
 * Unit Tests: ci-api.js
 *
 * Tests Chrome runtime message passing for Compass API calls.
 * Mocks chrome.runtime.sendMessage to simulate service worker responses.
 */

// Mock chrome.runtime
global.chrome = {
  runtime: {
    sendMessage: jest.fn(),
    lastError: null,
  },
};

// Inline the functions since ci-api.js uses IIFE/module pattern for content scripts
function fetchCompass(endpoint) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "CI_FETCH_COMPASS", endpoint },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.success) {
          reject(new Error(response?.error || "Failed to fetch Compass data"));
          return;
        }
        resolve(response.data);
      },
    );
  });
}

function fetchPortalMap(portal) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "CI_FETCH_PORTAL_MAP", portal },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.success) {
          reject(new Error(response?.error || "Failed to fetch portal map"));
          return;
        }
        resolve(response.data);
      },
    );
  });
}

function postStatus(statusPayload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "CI_POST_STATUS", payload: statusPayload },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.success) {
          reject(new Error(response?.error || "Failed to post status"));
          return;
        }
        resolve(response.data);
      },
    );
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  chrome.runtime.lastError = null;
});

// ── fetchCompass Tests ────────────────────────────────────────────────────────────

describe("fetchCompass", () => {
  it("sends correct message type and endpoint", async () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) =>
      cb({ success: true, data: { gpa: 3.7 } }),
    );
    await fetchCompass("profile");
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: "CI_FETCH_COMPASS", endpoint: "profile" },
      expect.any(Function),
    );
  });

  it("resolves with data on success", async () => {
    const mockData = { gpa: 3.7, satTotal: 1350 };
    chrome.runtime.sendMessage.mockImplementation((msg, cb) =>
      cb({ success: true, data: mockData }),
    );
    const result = await fetchCompass("profile");
    expect(result).toEqual(mockData);
  });

  it("rejects on chrome.runtime.lastError", async () => {
    chrome.runtime.lastError = { message: "Extension context invalidated" };
    chrome.runtime.sendMessage.mockImplementation((msg, cb) => cb(undefined));
    await expect(fetchCompass("profile")).rejects.toThrow(
      "Extension context invalidated",
    );
  });

  it("rejects when response.success is false", async () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) =>
      cb({ success: false, error: "Not authenticated" }),
    );
    await expect(fetchCompass("profile")).rejects.toThrow("Not authenticated");
  });

  it("rejects with default message when no error provided", async () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) =>
      cb({ success: false }),
    );
    await expect(fetchCompass("profile")).rejects.toThrow(
      "Failed to fetch Compass data",
    );
  });

  it("works for all 5 Compass endpoints", async () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) =>
      cb({ success: true, data: {} }),
    );
    for (const ep of [
      "profile",
      "activities",
      "essays",
      "financial",
      "colleges",
    ]) {
      await fetchCompass(ep);
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        { type: "CI_FETCH_COMPASS", endpoint: ep },
        expect.any(Function),
      );
    }
  });
});

// ── fetchPortalMap Tests ───────────────────────────────────────────────────────

describe("fetchPortalMap", () => {
  it("sends correct message for Common App", async () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) =>
      cb({ success: true, data: { portal: "common_app", sections: {} } }),
    );
    await fetchPortalMap("common_app");
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: "CI_FETCH_PORTAL_MAP", portal: "common_app" },
      expect.any(Function),
    );
  });

  it("resolves with portal map data", async () => {
    const map = {
      portal: "common_app",
      sections: { profile: { fields: [] } },
    };
    chrome.runtime.sendMessage.mockImplementation((msg, cb) =>
      cb({ success: true, data: map }),
    );
    const result = await fetchPortalMap("common_app");
    expect(result.portal).toBe("common_app");
    expect(result.sections).toBeDefined();
  });

  it("rejects on failure", async () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) =>
      cb({ success: false, error: "Portal not found" }),
    );
    await expect(fetchPortalMap("unknown")).rejects.toThrow("Portal not found");
  });
});

// ── postStatus Tests ───────────────────────────────────────────────────────────

describe("postStatus", () => {
  it("sends status payload correctly", async () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) =>
      cb({ success: true, data: {} }),
    );
    const status = {
      portal: "common_app",
      section: "profile",
      fieldsTotal: 20,
      fieldsFilled: 18,
      agentType: "extension",
    };
    await postStatus(status);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: "CI_POST_STATUS", payload: status },
      expect.any(Function),
    );
  });

  it("resolves on success", async () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) =>
      cb({ success: true, data: { saved: true } }),
    );
    const result = await postStatus({});
    expect(result).toEqual({ saved: true });
  });

  it("rejects on failure", async () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) =>
      cb({ success: false, error: "Auth expired" }),
    );
    await expect(postStatus({})).rejects.toThrow("Auth expired");
  });
});
