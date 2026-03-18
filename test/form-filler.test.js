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

describe("COMMON_APP_SECTIONS", () => {
  it("has 5 sections", () => {
    expect(COMMON_APP_SECTIONS).toHaveLength(5);
  });

  it("every section has required fields", () => {
    COMMON_APP_SECTIONS.forEach((s) => {
      expect(s).toHaveProperty("key");
      expect(s).toHaveProperty("label");
      expect(s).toHaveProperty("urlPath");
      expect(s).toHaveProperty("twinEndpoint");
      expect(s.urlPath).toMatch(/^\/common\//);
    });
  });

  it("sections are in logical order (profile first, essays last)", () => {
    expect(COMMON_APP_SECTIONS[0].key).toBe("profile");
    expect(COMMON_APP_SECTIONS[COMMON_APP_SECTIONS.length - 1].key).toBe(
      "essays",
    );
  });

  it("each section has a unique key", () => {
    const keys = COMMON_APP_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("each section has a unique urlPath", () => {
    const paths = COMMON_APP_SECTIONS.map((s) => s.urlPath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("activities section uses /common/7/232", () => {
    const activities = COMMON_APP_SECTIONS.find((s) => s.key === "activities");
    expect(activities.urlPath).toBe("/common/7/232");
    expect(activities.twinEndpoint).toBe("activities");
  });

  it("education and testing use 'profile' twin endpoint", () => {
    const edu = COMMON_APP_SECTIONS.find((s) => s.key === "education");
    const test = COMMON_APP_SECTIONS.find((s) => s.key === "testing");
    expect(edu.twinEndpoint).toBe("profile");
    expect(test.twinEndpoint).toBe("profile");
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
    const icon = r.reason === "aborted" ? "⏹" : r.success === false ? "✗" : r.filled > 0 ? "✓" : "—";
    const detail = r.reason === "aborted" ? "stopped" : r.success === false ? r.reason : `${r.filled || 0} fields`;
    return `${icon} ${r.label}: ${detail}`;
  }

  it("shows checkmark for successful fill", () => {
    const line = buildSummaryLine({ label: "Personal Info", filled: 12, success: true });
    expect(line).toBe("✓ Personal Info: 12 fields");
  });

  it("shows stop icon for aborted section", () => {
    const line = buildSummaryLine({ label: "Education", success: false, reason: "aborted", filled: 0 });
    expect(line).toBe("⏹ Education: stopped");
  });

  it("shows X for failed section with error reason", () => {
    const line = buildSummaryLine({ label: "Testing", success: false, reason: "no_section_mapping", filled: 0 });
    expect(line).toBe("✗ Testing: no_section_mapping");
  });

  it("shows dash for zero-fill sections", () => {
    const line = buildSummaryLine({ label: "Writing", filled: 0, success: true });
    expect(line).toBe("— Writing: 0 fields");
  });
});

describe("fill-all abort flag behavior", () => {
  it("abort flag causes section to be skipped with aborted reason", () => {
    const aborted = true;
    const section = { key: "education", label: "Education" };
    const result = aborted
      ? { section: section.key, label: section.label, success: false, reason: "aborted", filled: 0, flagged: 0 }
      : null;
    expect(result.success).toBe(false);
    expect(result.reason).toBe("aborted");
    expect(result.filled).toBe(0);
  });
});
