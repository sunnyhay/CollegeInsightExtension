/**
 * Unit Tests: telemetry.js
 *
 * Tests Application Insights envelope construction and telemetry helper
 * functions. Mocks fetch and chrome.runtime.getManifest.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockFetch = jest.fn(() => Promise.resolve());
global.fetch = mockFetch;

// Provide window object for Node test environment
global.window = global.window || {};

global.chrome = {
  runtime: {
    getManifest: () => ({ version: "1.0.0-test" }),
  },
};

// ── Load module (sets window.__ciTelemetry) ────────────────────────────────────

require("../src/lib/telemetry");

const telemetry = window.__ciTelemetry;

beforeEach(() => {
  mockFetch.mockClear();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("telemetry.trackEvent", () => {
  it("sends POST to Application Insights endpoint", () => {
    telemetry.trackEvent("test.event", { key: "val" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("dc.services.visualstudio.com");
    expect(opts.method).toBe("POST");
  });

  it("includes correct envelope structure", () => {
    telemetry.trackEvent("test.event", { portal: "commonapp" });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.name).toBe("Microsoft.ApplicationInsights.Event");
    expect(body.iKey).toBeTruthy();
    expect(body.data.baseType).toBe("EventData");
    expect(body.data.baseData.ver).toBe(2);
    expect(body.data.baseData.name).toBe("test.event");
  });

  it("includes agentType and extensionVersion in properties", () => {
    telemetry.trackEvent("test.event");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const props = body.data.baseData.properties;
    expect(props.agentType).toBe("extension");
    expect(props.extensionVersion).toBe("1.0.0-test");
  });

  it("merges custom properties", () => {
    telemetry.trackEvent("test.event", { portal: "uc", section: "activities" });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const props = body.data.baseData.properties;
    expect(props.portal).toBe("uc");
    expect(props.section).toBe("activities");
  });

  it("includes measurements", () => {
    telemetry.trackEvent("test.event", {}, { fieldsFilled: 12 });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data.baseData.measurements.fieldsFilled).toBe(12);
  });

  it("uses keepalive for fire-and-forget", () => {
    telemetry.trackEvent("test.event");
    expect(mockFetch.mock.calls[0][1].keepalive).toBe(true);
  });

  it("does not throw when fetch rejects", () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.reject(new Error("network")),
    );
    expect(() => telemetry.trackEvent("test.event")).not.toThrow();
  });
});

describe("telemetry helper functions", () => {
  it("trackPortalDetected sends portal, section, url", () => {
    telemetry.trackPortalDetected(
      "commonapp",
      "education",
      "https://example.com",
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data.baseData.name).toBe("agent.portal.detected");
    expect(body.data.baseData.properties.portal).toBe("commonapp");
    expect(body.data.baseData.properties.section).toBe("education");
  });

  it("trackPortalUnknown sends domain and fieldCount", () => {
    telemetry.trackPortalUnknown("unknown.edu", 15);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data.baseData.name).toBe("agent.portal.unknown");
    expect(body.data.baseData.properties.domain).toBe("unknown.edu");
    expect(body.data.baseData.measurements.fieldCount).toBe(15);
  });

  it("trackFillStarted sends portal and section", () => {
    telemetry.trackFillStarted("uc_app", "personal");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data.baseData.name).toBe("agent.fill.started");
  });

  it("trackFillCompleted sends fill metrics", () => {
    telemetry.trackFillCompleted("commonapp", "education", 20, 18, 2);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data.baseData.name).toBe("agent.fill.completed");
    expect(body.data.baseData.measurements.fieldsTotal).toBe(20);
    expect(body.data.baseData.measurements.fieldsFilled).toBe(18);
    expect(body.data.baseData.measurements.fieldsFlagged).toBe(2);
  });

  it("trackTimeSaved calculates estimatedSeconds from fieldsFilled", () => {
    telemetry.trackTimeSaved(10);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data.baseData.name).toBe("agent.time_saved");
    expect(body.data.baseData.measurements.estimatedSeconds).toBe(300); // 10 * 30
    expect(body.data.baseData.measurements.fieldsFilled).toBe(10);
  });

  it("trackSessionDuration sends duration and activity counts", () => {
    telemetry.trackSessionDuration(120000, 3, 45);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data.baseData.name).toBe("agent.session.duration");
    expect(body.data.baseData.measurements.durationMs).toBe(120000);
    expect(body.data.baseData.measurements.portalsVisited).toBe(3);
  });

  it("trackStatusWriteback sends status", () => {
    telemetry.trackStatusWriteback("commonapp", "education", "filled");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data.baseData.name).toBe("agent.status.writeback");
    expect(body.data.baseData.properties.status).toBe("filled");
  });
});
