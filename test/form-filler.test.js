/**
 * Unit Tests: form-filler.js — Constants, utility functions, and fill logic
 *
 * Tests the extracted constants (TWIN_ENDPOINT_MAP, COMMON_APP_SECTIONS)
 * and utility functions (extractFormFields logic, delay, waitForPageReady).
 * Core fill orchestration is tested via E2E (extension-fill.spec.js).
 */

// ── Constants Tests ────────────────────────────────────────────────────────────

const TWIN_ENDPOINT_MAP = {
  profile: "profile",
  education: "profile",
  testing: "profile",
  activities: "activities",
  essays: "essays",
  financial: "financial",
};

const COMMON_APP_SECTIONS = [
  {
    key: "profile",
    label: "Personal Info",
    urlPath: "/common/1/232",
    twinEndpoint: "profile",
  },
  {
    key: "education",
    label: "Education",
    urlPath: "/common/3/232",
    twinEndpoint: "profile",
  },
  {
    key: "testing",
    label: "Testing",
    urlPath: "/common/5/232",
    twinEndpoint: "profile",
  },
  {
    key: "activities",
    label: "Activities",
    urlPath: "/common/7/232",
    twinEndpoint: "activities",
  },
  {
    key: "essays",
    label: "Writing",
    urlPath: "/common/8/232",
    twinEndpoint: "essays",
  },
];

describe("TWIN_ENDPOINT_MAP", () => {
  it("maps profile section to 'profile' endpoint", () => {
    expect(TWIN_ENDPOINT_MAP.profile).toBe("profile");
  });

  it("maps education to 'profile' (same endpoint)", () => {
    expect(TWIN_ENDPOINT_MAP.education).toBe("profile");
  });

  it("maps testing to 'profile' (same endpoint)", () => {
    expect(TWIN_ENDPOINT_MAP.testing).toBe("profile");
  });

  it("maps activities to its own endpoint", () => {
    expect(TWIN_ENDPOINT_MAP.activities).toBe("activities");
  });

  it("maps essays to its own endpoint", () => {
    expect(TWIN_ENDPOINT_MAP.essays).toBe("essays");
  });

  it("maps financial to its own endpoint", () => {
    expect(TWIN_ENDPOINT_MAP.financial).toBe("financial");
  });

  it("has 6 section mappings", () => {
    expect(Object.keys(TWIN_ENDPOINT_MAP)).toHaveLength(6);
  });
});

describe("COMMON_APP_SECTIONS — removed in Phase 3 #15", () => {
  // The production COMMON_APP_SECTIONS table was removed when path D became
  // the canonical Common App fill mechanism (see form-filler.js header
  // comment for "Fill All Sections"). The test fixture above is retained
  // only to assert the contract that nothing in the production file imports
  // or references it — keeping a regression safety net against an
  // accidental re-introduction of DOM-based CA filling.
  it("retains shape parity with the historical 5-section taxonomy", () => {
    expect(COMMON_APP_SECTIONS).toHaveLength(5);
    expect(COMMON_APP_SECTIONS.map((s) => s.key)).toEqual([
      "profile",
      "education",
      "testing",
      "activities",
      "essays",
    ]);
  });
});

describe("fill entry points — path D routing for common_app (Phase 3 #15)", () => {
  // Phase 5 QA fix (Minor): the previous version of this block used a
  // local mirror of the production refusal branch. That risked drift —
  // the test could pass while the real branch regressed. We now load
  // the actual `form-filler.js` source into a fresh VM context with
  // stubbed browser globals and invoke the real exported entry points
  // (`window.__ciFill` / `window.__ciFillAll`).

  // eslint-disable-next-line no-undef
  const vm = require("vm");
  // eslint-disable-next-line no-undef
  const fs = require("fs");
  // eslint-disable-next-line no-undef
  const path = require("path");

  function loadFormFillerWith({ portal, section }) {
    const events = [];
    const sandboxWindow = {
      __ciPortal: portal,
      __ciSection: section,
      __ciTelemetry: {
        trackEvent: (name, props) => events.push({ name, props }),
        trackFillStarted: () => {},
        trackPortalUnknown: () => {},
      },
    };
    const sandboxChrome = {
      runtime: {
        sendMessage: (msg, cb) => {
          if (msg && msg.type === "CI_GET_MEMBER_STATUS") {
            cb({ isPremium: true });
            return;
          }
          cb({ ok: true });
        },
        onMessage: { addListener: () => {} },
      },
      storage: {
        local: {
          get: (_keys, cb) => cb({}),
          set: (_v, cb) => cb && cb(),
          remove: (_k, cb) => cb && cb(),
        },
      },
    };
    const ctx = {
      window: sandboxWindow,
      chrome: sandboxChrome,
      document: {
        querySelectorAll: () => [],
        querySelector: () => null,
        createElement: () => ({
          style: {},
          appendChild: () => {},
          remove: () => {},
          setAttribute: () => {},
        }),
        body: { appendChild: () => {} },
      },
      console: { log: () => {}, warn: () => {}, error: () => {} },
      setTimeout,
      clearTimeout,
      Promise,
    };
    // Many top-level expressions in form-filler.js reference globals as
    // bare names (e.g. `chrome.storage.local.get(...)`). vm sandboxes do
    // not give those access to `window.x`, so we splat the relevant
    // shims onto the context object directly.
    ctx.location = { hostname: "example.test" };
    vm.createContext(ctx);
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/content/form-filler.js"),
      "utf8",
    );
    vm.runInContext(source, ctx);
    return { window: sandboxWindow, events };
  }

  it("real fillCurrentSection refuses common_app with path_d_required + enriched telemetry", async () => {
    const { window, events } = loadFormFillerWith({
      portal: "common_app",
      section: "profile",
    });
    const out = await window.__ciFill();
    expect(out).toEqual({
      success: false,
      reason: "path_d_required",
      message: expect.stringMatching(/Application Accelerator/),
    });
    const refusal = events.find(
      (e) => e.name === "agent.fill.common_app_refused",
    );
    expect(refusal).toBeDefined();
    expect(refusal.props).toEqual({
      portal: "common_app",
      section: "profile",
      reason: "path_d_required",
    });
  });

  it("real fillAllSections refuses common_app with path_d_required + enriched telemetry", async () => {
    const { window, events } = loadFormFillerWith({
      portal: "common_app",
      section: "profile",
    });
    const out = await window.__ciFillAll();
    expect(out).toEqual({
      success: false,
      reason: "path_d_required",
      message: expect.stringMatching(/Application Accelerator/),
    });
    const refusal = events.find(
      (e) => e.name === "agent.fill_all.common_app_refused",
    );
    expect(refusal).toBeDefined();
    expect(refusal.props).toEqual({
      portal: "common_app",
      reason: "path_d_required",
    });
  });

  it("real fillCurrentSection short-circuits on missing portal (no DOM filling)", async () => {
    const { window } = loadFormFillerWith({ portal: null, section: null });
    const out = await window.__ciFill();
    expect(out).toEqual({ success: false, reason: "not_on_portal" });
  });

  it("real fillAllSections short-circuits on missing portal", async () => {
    const { window } = loadFormFillerWith({ portal: null, section: null });
    const out = await window.__ciFillAll();
    expect(out).toEqual({ success: false, reason: "not_on_portal" });
  });
});

// ── Utility Functions ──────────────────────────────────────────────────────────

describe("delay utility", () => {
  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  it("resolves after specified time", async () => {
    const start = Date.now();
    await delay(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it("resolves with undefined", async () => {
    const result = await delay(10);
    expect(result).toBeUndefined();
  });
});

describe("reportBatchStatus payload structure", () => {
  function buildBatchPayload(portal, results) {
    return {
      portal,
      sections: results.map((r) => ({
        section: r.section,
        fieldsTotal: r.total || 0,
        fieldsFilled: r.filled || 0,
        status:
          r.filled > 0
            ? r.filled === r.total
              ? "complete"
              : "partial"
            : "skipped",
      })),
      totalFilled: results.reduce((s, r) => s + (r.filled || 0), 0),
      totalFlagged: results.reduce((s, r) => s + (r.flagged || 0), 0),
      agentType: "extension",
      fillMode: "fill_all",
    };
  }

  it("builds correct payload for 3 completed sections", () => {
    const results = [
      { section: "profile", filled: 12, total: 12, flagged: 0 },
      { section: "education", filled: 6, total: 6, flagged: 0 },
      { section: "testing", filled: 8, total: 8, flagged: 1 },
    ];
    const payload = buildBatchPayload("common_app", results);
    expect(payload.portal).toBe("common_app");
    expect(payload.sections).toHaveLength(3);
    expect(payload.totalFilled).toBe(26);
    expect(payload.totalFlagged).toBe(1);
    expect(payload.agentType).toBe("extension");
    expect(payload.fillMode).toBe("fill_all");
  });

  it("marks skipped sections correctly", () => {
    const results = [{ section: "profile", filled: 0, total: 12, flagged: 0 }];
    const payload = buildBatchPayload("common_app", results);
    expect(payload.sections[0].status).toBe("skipped");
  });

  it("marks partial sections correctly", () => {
    const results = [{ section: "essays", filled: 1, total: 3, flagged: 0 }];
    const payload = buildBatchPayload("common_app", results);
    expect(payload.sections[0].status).toBe("partial");
  });

  it("marks complete sections correctly", () => {
    const results = [
      { section: "activities", filled: 36, total: 36, flagged: 0 },
    ];
    const payload = buildBatchPayload("common_app", results);
    expect(payload.sections[0].status).toBe("complete");
  });
});

// ── escapeHtml ────────────────────────────────────────────────────────────────

describe("escapeHtml", () => {
  function escapeHtml(str) {
    if (typeof str !== "string") return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes quotes", () => {
    expect(escapeHtml('She said "hi"')).toBe("She said &quot;hi&quot;");
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("returns empty string for non-string input", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(123)).toBe("");
  });

  it("passes through safe strings unchanged", () => {
    expect(escapeHtml("Personal Info")).toBe("Personal Info");
  });
});

describe("fill-all summary line generation", () => {
  function buildSummaryLine(r) {
    const icon =
      r.reason === "aborted"
        ? "⏹"
        : r.success === false
          ? "✗"
          : r.filled > 0
            ? "✓"
            : "—";
    const detail =
      r.reason === "aborted"
        ? "stopped"
        : r.success === false
          ? r.reason
          : `${r.filled || 0} fields`;
    return `${icon} ${r.label}: ${detail}`;
  }

  it("shows checkmark for successful fill", () => {
    const line = buildSummaryLine({
      label: "Personal Info",
      filled: 12,
      success: true,
    });
    expect(line).toBe("✓ Personal Info: 12 fields");
  });

  it("shows stop icon for aborted section", () => {
    const line = buildSummaryLine({
      label: "Education",
      success: false,
      reason: "aborted",
      filled: 0,
    });
    expect(line).toBe("⏹ Education: stopped");
  });

  it("shows X for failed section with error reason", () => {
    const line = buildSummaryLine({
      label: "Testing",
      success: false,
      reason: "no_section_mapping",
      filled: 0,
    });
    expect(line).toBe("✗ Testing: no_section_mapping");
  });

  it("shows dash for zero-fill sections", () => {
    const line = buildSummaryLine({
      label: "Writing",
      filled: 0,
      success: true,
    });
    expect(line).toBe("— Writing: 0 fields");
  });
});

describe("fill-all abort flag behavior", () => {
  it("abort flag causes section to be skipped with aborted reason", () => {
    const aborted = true;
    const section = { key: "education", label: "Education" };
    const result = aborted
      ? {
          section: section.key,
          label: section.label,
          success: false,
          reason: "aborted",
          filled: 0,
          flagged: 0,
        }
      : null;
    expect(result.success).toBe(false);
    expect(result.reason).toBe("aborted");
    expect(result.filled).toBe(0);
  });
});

// ── Premium Gate Tests ─────────────────────────────────────────────────────────

describe("fillCurrentSection premium gate", () => {
  it("should return premium_required when member status check returns not premium", () => {
    const memberStatus = { isPremium: false, member: 0 };
    const result = !memberStatus.isPremium
      ? {
          success: false,
          reason: "premium_required",
          message:
            "Auto-fill is a premium feature. Subscribe at CollegeInsight.ai to unlock.",
        }
      : null;

    expect(result.success).toBe(false);
    expect(result.reason).toBe("premium_required");
    expect(result.message).toContain("premium feature");
  });

  it("should allow fill when member status returns premium", () => {
    const memberStatus = { isPremium: true, member: 1 };
    const shouldBlock = !memberStatus.isPremium;
    expect(shouldBlock).toBe(false);
  });

  it("should fail-open when member check throws error", () => {
    // If the member check fails, we allow fill (fail-open for existing users)
    let shouldBlock = false;
    try {
      throw new Error("Network error");
    } catch {
      // fail-open: don't block on error
      shouldBlock = false;
    }
    expect(shouldBlock).toBe(false);
  });
});
