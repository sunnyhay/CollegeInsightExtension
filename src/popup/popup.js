/**
 * popup.js — Extension popup logic.
 * Shows connection status, current portal, and fill actions.
 */

const statusEl = document.getElementById("status");
const portalInfoEl = document.getElementById("portal-info");
const portalTextEl = document.getElementById("portal-text");
const fillBtn = document.getElementById("fill-btn");
const statsEl = document.getElementById("stats");

// Check auth status
chrome.runtime.sendMessage({ type: "CI_GET_STATUS" }, (resp) => {
  if (resp?.authenticated) {
    statusEl.className = "status connected";
    statusEl.textContent = "Connected to CollegeInsight";
  } else {
    statusEl.className = "status disconnected";
    statusEl.textContent = "Not connected — open CollegeInsight to sign in";
  }
});

// Check current tab for portal detection (with loading state + 5s timeout)
fillBtn.textContent = "Checking connection...";
fillBtn.disabled = true;

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab) return;

  const portalTimeout = setTimeout(() => {
    fillBtn.textContent = "Unable to check status";
    fillBtn.disabled = true;
  }, 5000);

  chrome.tabs.sendMessage(tab.id, { type: "CI_GET_PORTAL_INFO" }, (resp) => {
    clearTimeout(portalTimeout);
    if (chrome.runtime.lastError || !resp?.portal) {
      portalInfoEl.style.display = "none";
      fillBtn.disabled = true;
      fillBtn.textContent = "Not on a supported portal";
      return;
    }

    portalInfoEl.style.display = "block";
    portalTextEl.textContent = `${formatPortalName(resp.portal)} — ${resp.section} section`;
    fillBtn.disabled = false;
    fillBtn.textContent = `Fill ${resp.section || "form"}`;
  });
});

// Fill button
fillBtn.addEventListener("click", async () => {
  fillBtn.disabled = true;
  fillBtn.textContent = "Filling...";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { type: "CI_FILL_SECTION" }, (result) => {
    if (chrome.runtime.lastError) {
      fillBtn.textContent = "Fill failed — try again";
      fillBtn.disabled = false;
      return;
    }
    if (result?.success) {
      fillBtn.textContent = `Done — ${result.filled} fields filled`;
      fillBtn.className = "btn btn-primary";
      const timeSaved = Math.round((result.filled * 30) / 60);
      statsEl.textContent = `~${timeSaved} minutes saved this session`;

      // Update cumulative stats
      chrome.storage.local.get(
        ["totalFieldsFilled", "totalSessions"],
        (data) => {
          const newTotal = (data.totalFieldsFilled || 0) + result.filled;
          const newSessions = (data.totalSessions || 0) + 1;
          chrome.storage.local.set({
            totalFieldsFilled: newTotal,
            totalSessions: newSessions,
          });
        },
      );
    } else {
      fillBtn.textContent = "Fill failed — try again";
      fillBtn.disabled = false;
    }
  });
});

// Load cumulative stats
chrome.storage.local.get(["totalFieldsFilled", "totalSessions"], (data) => {
  const total = data.totalFieldsFilled || 0;
  const sessions = data.totalSessions || 0;
  if (total > 0) {
    const hours = ((total * 30) / 3600).toFixed(1);
    statsEl.textContent = `All time: ${total} fields filled across ${sessions} sessions (~${hours} hrs saved)`;
  }
});

function formatPortalName(portal) {
  const names = {
    common_app: "Common App",
    uc_app: "UC Application",
    fafsa: "FAFSA",
    css_profile: "CSS Profile",
    college_board: "College Board",
    act: "ACT",
    coalition: "Coalition App",
  };
  return names[portal] || portal;
}
