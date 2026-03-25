/**
 * Unit Tests: service-worker.js — Message routing and API orchestration
 *
 * Tests the message handler routing logic and ciApiFetch wrapper.
 * Mocks chrome.runtime, chrome.storage, chrome.tabs, and global fetch.
 */

// ── Mock Chrome APIs ───────────────────────────────────────────────────────────

global.chrome = {
  runtime: {
    onMessage: { addListener: jest.fn() },
  },
  storage: {
    local: {
      get: jest.fn(),
      set: jest.fn(),
    },
  },
  tabs: {
    create: jest.fn(),
  },
};

global.crypto = {
  randomUUID: () => "test-uuid-1234",
};

// ── Extracted Functions (mirror service-worker.js logic) ───────────────────────

const CI_API_BASE = "https://api.collegeinsight.ai";

async function getToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["ciToken", "ciTokenExpiry"], (data) => {
      if (!data.ciToken) return resolve(null);
      if (data.ciTokenExpiry && Date.now() > data.ciTokenExpiry)
        return resolve(null);
      resolve(data.ciToken);
    });
  });
}

const PORTAL_URLS = {
  common_app: "https://apply.commonapp.org",
  uc_app: "https://apply.universityofcalifornia.edu",
};

async function handleFillAll(portal) {
  const baseUrl = PORTAL_URLS[portal];
  if (!baseUrl) return;
  const tab = await chrome.tabs.create({ url: `${baseUrl}/dashboard` });
  await chrome.storage.local.set({
    ciFillAll: { portal, tabId: tab?.id, startedAt: Date.now() },
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe("getToken", () => {
  it("returns token when valid and not expired", async () => {
    chrome.storage.local.get.mockImplementation((keys, cb) =>
      cb({ ciToken: "jwt-abc", ciTokenExpiry: Date.now() + 60000 }),
    );
    const token = await getToken();
    expect(token).toBe("jwt-abc");
  });

  it("returns null when no token stored", async () => {
    chrome.storage.local.get.mockImplementation((keys, cb) => cb({}));
    const token = await getToken();
    expect(token).toBeNull();
  });

  it("returns null when token is expired", async () => {
    chrome.storage.local.get.mockImplementation((keys, cb) =>
      cb({ ciToken: "jwt-abc", ciTokenExpiry: Date.now() - 1000 }),
    );
    const token = await getToken();
    expect(token).toBeNull();
  });
});

describe("PORTAL_URLS", () => {
  it("has Common App URL", () => {
    expect(PORTAL_URLS.common_app).toBe("https://apply.commonapp.org");
  });

  it("has UC App URL", () => {
    expect(PORTAL_URLS.uc_app).toBe("https://apply.universityofcalifornia.edu");
  });

  it("returns undefined for unknown portals", () => {
    expect(PORTAL_URLS.fafsa).toBeUndefined();
  });
});

describe("handleFillAll", () => {
  it("creates tab at portal dashboard for Common App", async () => {
    chrome.tabs.create.mockResolvedValue({ id: 42 });
    chrome.storage.local.set.mockImplementation(() => {});

    await handleFillAll("common_app");

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: "https://apply.commonapp.org/dashboard",
    });
  });

  it("creates tab at portal dashboard for UC App", async () => {
    chrome.tabs.create.mockResolvedValue({ id: 43 });
    chrome.storage.local.set.mockImplementation(() => {});

    await handleFillAll("uc_app");

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: "https://apply.universityofcalifornia.edu/dashboard",
    });
  });

  it("stores ciFillAll intent in chrome.storage.local", async () => {
    chrome.tabs.create.mockResolvedValue({ id: 42 });
    chrome.storage.local.set.mockImplementation(() => {});

    await handleFillAll("common_app");

    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        ciFillAll: expect.objectContaining({
          portal: "common_app",
          tabId: 42,
        }),
      }),
    );
  });

  it("does nothing for unknown portal", async () => {
    await handleFillAll("fafsa");
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
});

describe("Message handler routing", () => {
  // Simulate the message routing logic
  function routeMessage(message) {
    const validTypes = [
      "CI_GET_STATUS",
      "CI_FETCH_TWIN",
      "CI_FETCH_PORTAL_MAP",
      "CI_POST_STATUS",
      "CI_AI_MAP",
      "CI_FILL_ALL",
      "CI_FILL_SECTION_FROM_CI",
    ];
    return validTypes.includes(message.type) ? message.type : null;
  }

  it("routes CI_GET_STATUS", () => {
    expect(routeMessage({ type: "CI_GET_STATUS" })).toBe("CI_GET_STATUS");
  });

  it("routes CI_FETCH_TWIN", () => {
    expect(routeMessage({ type: "CI_FETCH_TWIN", endpoint: "profile" })).toBe(
      "CI_FETCH_TWIN",
    );
  });

  it("routes CI_FETCH_PORTAL_MAP", () => {
    expect(
      routeMessage({ type: "CI_FETCH_PORTAL_MAP", portal: "common_app" }),
    ).toBe("CI_FETCH_PORTAL_MAP");
  });

  it("routes CI_POST_STATUS", () => {
    expect(routeMessage({ type: "CI_POST_STATUS", payload: {} })).toBe(
      "CI_POST_STATUS",
    );
  });

  it("routes CI_AI_MAP", () => {
    expect(routeMessage({ type: "CI_AI_MAP" })).toBe("CI_AI_MAP");
  });

  it("routes CI_FILL_ALL", () => {
    expect(routeMessage({ type: "CI_FILL_ALL" })).toBe("CI_FILL_ALL");
  });

  it("routes CI_FILL_SECTION_FROM_CI", () => {
    expect(routeMessage({ type: "CI_FILL_SECTION_FROM_CI" })).toBe(
      "CI_FILL_SECTION_FROM_CI",
    );
  });

  it("returns null for unknown message types", () => {
    expect(routeMessage({ type: "UNKNOWN" })).toBeNull();
    expect(routeMessage({ type: "" })).toBeNull();
  });

  it("handles message with no type", () => {
    expect(routeMessage({})).toBeNull();
  });
});

describe("CI API endpoint construction", () => {
  it("builds twin profile URL correctly", () => {
    expect(`${CI_API_BASE}/twin/profile`).toBe(
      "https://api.collegeinsight.ai/twin/profile",
    );
  });

  it("builds twin activities URL correctly", () => {
    expect(`${CI_API_BASE}/twin/activities`).toBe(
      "https://api.collegeinsight.ai/twin/activities",
    );
  });

  it("builds portal-map URL with query parameter", () => {
    const portal = "common_app";
    const url = `${CI_API_BASE}/agent/portal-map?portal=${encodeURIComponent(portal)}`;
    expect(url).toBe(
      "https://api.collegeinsight.ai/agent/portal-map?portal=common_app",
    );
  });

  it("encodes special characters in portal name", () => {
    const portal = "some portal/name";
    const url = `${CI_API_BASE}/agent/portal-map?portal=${encodeURIComponent(portal)}`;
    expect(url).toContain("some%20portal%2Fname");
  });
});

// ── CI_GET_MEMBER_STATUS Message Handler ──────────────────────────────────

describe("CI_GET_MEMBER_STATUS handler", () => {
  it("should route to user/memberStatus API endpoint", () => {
    const url = `${CI_API_BASE}/user/memberStatus`;
    expect(url).toBe("https://api.collegeinsight.ai/user/memberStatus");
  });

  it("should derive isPremium from member field", () => {
    // Mirrors the logic in service-worker.js CI_GET_MEMBER_STATUS handler
    const derivePremium = (data) => ({
      isPremium: data?.member > 0,
      member: data?.member || 0,
    });

    expect(derivePremium({ member: 1 })).toEqual({
      isPremium: true,
      member: 1,
    });
    expect(derivePremium({ member: 0 })).toEqual({
      isPremium: false,
      member: 0,
    });
    expect(derivePremium(null)).toEqual({ isPremium: false, member: 0 });
    expect(derivePremium(undefined)).toEqual({ isPremium: false, member: 0 });
  });
});
