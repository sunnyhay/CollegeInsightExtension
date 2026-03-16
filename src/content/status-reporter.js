/**
 * status-reporter.js — Reports form-filling results back to CI backend.
 */

async function reportStatus(
  portal,
  section,
  status,
  fieldsTotal,
  fieldsFilled,
) {
  const payload = {
    portal,
    section,
    status,
    fieldsTotal,
    fieldsFilled,
    agentType: "extension",
    timestamp: new Date().toISOString(),
  };

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "CI_POST_STATUS", payload }, (resp) => {
      window.__ciTelemetry?.trackStatusWriteback(portal, section, status);
      resolve(resp);
    });
  });
}

window.__ciReportStatus = reportStatus;
