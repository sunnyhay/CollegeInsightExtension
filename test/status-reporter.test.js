/**
 * Unit Tests: status-reporter.js
 *
 * Tests the reportStatus function that sends fill results to the CI backend
 * via chrome.runtime.sendMessage.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

global.window = global.window || {};

const sendMessageCalls = [];
global.chrome = {
  runtime: {
    sendMessage: jest.fn((msg, cb) => {
      sendMessageCalls.push(msg);
      if (cb) cb({ success: true });
    }),
  },
};

// Mock telemetry on window
window.__ciTelemetry = {
  trackStatusWriteback: jest.fn(),
};

// ── Load module ────────────────────────────────────────────────────────────────

require("../src/content/status-reporter");

const reportStatus = window.__ciReportStatus;

beforeEach(() => {
  sendMessageCalls.length = 0;
  chrome.runtime.sendMessage.mockClear();
  window.__ciTelemetry.trackStatusWriteback.mockClear();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("reportStatus", () => {
  it("is exposed on window.__ciReportStatus", () => {
    expect(typeof reportStatus).toBe("function");
  });

  it("sends CI_POST_STATUS message via chrome.runtime.sendMessage", async () => {
    await reportStatus("commonapp", "education", "filled", 20, 18);

    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const msg = sendMessageCalls[0];
    expect(msg.type).toBe("CI_POST_STATUS");
  });

  it("payload includes portal, section, status, fields", async () => {
    await reportStatus("commonapp", "activities", "partial", 15, 10);

    const payload = sendMessageCalls[0].payload;
    expect(payload.portal).toBe("commonapp");
    expect(payload.section).toBe("activities");
    expect(payload.status).toBe("partial");
    expect(payload.fieldsTotal).toBe(15);
    expect(payload.fieldsFilled).toBe(10);
  });

  it("payload includes agentType and timestamp", async () => {
    await reportStatus("uc_app", "personal", "filled", 10, 10);

    const payload = sendMessageCalls[0].payload;
    expect(payload.agentType).toBe("extension");
    expect(payload.timestamp).toBeTruthy();
    // Timestamp should be a valid ISO string
    expect(new Date(payload.timestamp).toISOString()).toBe(payload.timestamp);
  });

  it("calls telemetry trackStatusWriteback", async () => {
    await reportStatus("commonapp", "education", "filled", 20, 18);

    expect(window.__ciTelemetry.trackStatusWriteback).toHaveBeenCalledWith(
      "commonapp",
      "education",
      "filled",
    );
  });

  it("resolves with the callback response", async () => {
    const result = await reportStatus("commonapp", "education", "ok", 1, 1);
    expect(result).toEqual({ success: true });
  });
});
