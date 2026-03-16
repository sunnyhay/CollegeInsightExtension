/**
 * portal-detector.js — Content script that runs on application portals.
 * Detects which portal and section the student is viewing.
 */

const PORTAL_PATTERNS = [
  { portal: "common_app", pattern: /apply\.commonapp\.org/i },
  { portal: "uc_app", pattern: /admission\.universityofcalifornia\.edu/i },
  { portal: "fafsa", pattern: /studentaid\.gov/i },
  { portal: "css_profile", pattern: /cssprofile\.collegeboard\.org/i },
  { portal: "college_board", pattern: /collegeboard\.org/i },
  { portal: "act", pattern: /my\.act\.org/i },
  { portal: "coalition", pattern: /coalitionforcollegeaccess\.org/i },
];

function detectPortal() {
  const hostname = window.location.hostname;
  for (const { portal, pattern } of PORTAL_PATTERNS) {
    if (pattern.test(hostname)) {
      return portal;
    }
  }
  return null;
}

function detectSection() {
  const path = window.location.pathname.toLowerCase();
  if (/profile|personal|about/.test(path)) return "profile";
  if (/education|school|academic/.test(path)) return "education";
  if (/test|score|sat|act/.test(path)) return "testing";
  if (/activit/.test(path)) return "activities";
  if (/essay|writing|personal.insight|piq/.test(path)) return "essays";
  if (/financial|fafsa|css/.test(path)) return "financial";
  return "unknown";
}

// Expose detection results to other content scripts
window.__ciPortal = detectPortal();
window.__ciSection = detectSection();

// Notify service worker
if (window.__ciPortal) {
  chrome.runtime.sendMessage({
    type: "CI_PORTAL_DETECTED",
    portal: window.__ciPortal,
    section: window.__ciSection,
    url: window.location.href,
  });

  // Track portal detection
  window.__ciTelemetry?.trackPortalDetected(
    window.__ciPortal,
    window.__ciSection,
    window.location.href,
  );
}

// Respond to popup queries
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "CI_GET_PORTAL_INFO") {
    sendResponse({
      portal: window.__ciPortal,
      section: window.__ciSection,
      url: window.location.href,
    });
    return true;
  }
  return false;
});
