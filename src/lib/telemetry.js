/**
 * telemetry.js — Application Insights telemetry for the CollegeInsight extension.
 *
 * Lightweight tracker — sends events via the App Insights REST endpoint
 * (no SDK dependency, keeps extension bundle minimal).
 *
 * Events defined in design doc Section 6.2.
 */

const APPINSIGHTS_ENDPOINT = "https://dc.services.visualstudio.com/v2/track";

// Instrumentation key is public (client-side telemetry) — not a secret
const INSTRUMENTATION_KEY = "0f2a4e7d-8b3c-4d1e-9f5a-6c7b8d9e0f1a";

/**
 * Send a telemetry event to Application Insights.
 * @param {string} name - Event name (e.g., "agent.fill.completed")
 * @param {Record<string, string>} properties - String key-value properties
 * @param {Record<string, number>} [measurements] - Numeric measurements
 */
function trackEvent(name, properties = {}, measurements = {}) {
  const envelope = {
    name: "Microsoft.ApplicationInsights.Event",
    time: new Date().toISOString(),
    iKey: INSTRUMENTATION_KEY,
    data: {
      baseType: "EventData",
      baseData: {
        ver: 2,
        name,
        properties: {
          agentType: "extension",
          extensionVersion: chrome.runtime.getManifest().version,
          ...properties,
        },
        measurements,
      },
    },
  };

  // Fire-and-forget — don't block on telemetry
  fetch(APPINSIGHTS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
    keepalive: true,
  }).catch(() => {
    // Telemetry failure is non-critical
  });
}

/**
 * Track portal detection.
 */
function trackPortalDetected(portal, section, url) {
  trackEvent("agent.portal.detected", { portal, section, url });
}

/**
 * Track unknown portal (no mapping found).
 */
function trackPortalUnknown(domain, fieldCount) {
  trackEvent("agent.portal.unknown", { domain }, { fieldCount });
}

/**
 * Track fill started.
 */
function trackFillStarted(portal, section) {
  trackEvent("agent.fill.started", { portal, section });
}

/**
 * Track fill completed.
 */
function trackFillCompleted(
  portal,
  section,
  fieldsTotal,
  fieldsFilled,
  fieldsFlagged,
) {
  trackEvent(
    "agent.fill.completed",
    { portal, section },
    { fieldsTotal, fieldsFilled, fieldsFlagged },
  );
}

/**
 * Track status write-back.
 */
function trackStatusWriteback(portal, section, status) {
  trackEvent("agent.status.writeback", { portal, section, status });
}

/**
 * Track time saved.
 */
function trackTimeSaved(fieldsFilled) {
  const estimatedSeconds = fieldsFilled * 30;
  trackEvent("agent.time_saved", {}, { estimatedSeconds, fieldsFilled });
}

/**
 * Track session duration.
 */
function trackSessionDuration(durationMs, portalsVisited, fieldsFilled) {
  trackEvent(
    "agent.session.duration",
    {},
    { durationMs, portalsVisited, fieldsFilled },
  );
}

// Expose for use by other extension scripts
window.__ciTelemetry = {
  trackEvent,
  trackPortalDetected,
  trackPortalUnknown,
  trackFillStarted,
  trackFillCompleted,
  trackStatusWriteback,
  trackTimeSaved,
  trackSessionDuration,
};
