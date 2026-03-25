/**
 * form-filler.js — Core form-filling engine.
 * Loads Twin data + field mapping, fills DOM fields, shows preview overlay.
 *
 * Dependencies (loaded as content scripts before this file):
 * - window.__ciPortal / window.__ciSection (from portal-detector.js)
 * - window.__ciInputSimulator (from input-simulator.js)
 * - window.__ciFieldMapper (from field-mapper.js — loaded via lib/)
 *
 * CI API calls go through the service worker via chrome.runtime.sendMessage.
 */

const TWIN_ENDPOINT_MAP = {
  profile: "profile",
  education: "profile",
  testing: "profile",
  activities: "activities",
  essays: "essays",
  financial: "financial",
};

/** Escape HTML special characters to prevent XSS in innerHTML. */
function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Main entry point: fill the current portal section.
 */
async function fillCurrentSection() {
  // Premium check: only premium members can use auto-fill
  try {
    const memberStatus = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "CI_GET_MEMBER_STATUS" }, (response) =>
        resolve(response || {}),
      );
    });
    if (!memberStatus.isPremium) {
      window.__ciTelemetry?.trackEvent("agent.fill.premium_required");
      return {
        success: false,
        reason: "premium_required",
        message:
          "Auto-fill is a premium feature. Subscribe at CollegeInsight.ai to unlock.",
      };
    }
  } catch {
    // If member check fails, allow fill (fail-open for existing users)
  }

  const portal = window.__ciPortal;
  const section = window.__ciSection;

  if (!portal) {
    console.warn("[CI] Not on a recognized portal.");
    return { success: false, reason: "not_on_portal" };
  }

  try {
    // 1. Fetch portal map (or AI fallback for unknown portals)
    window.__ciTelemetry?.trackFillStarted(portal, section);
    let sectionMap;
    let isAiFallback = false;

    try {
      const portalMap = await fetchFromBackground("CI_FETCH_PORTAL_MAP", {
        portal,
      });
      sectionMap = portalMap.sections?.[section];
    } catch {
      // Portal map not found — try AI fallback
      window.__ciTelemetry?.trackEvent("agent.portal_map.miss", {
        portal,
        section,
      });
    }

    if (!sectionMap) {
      // AI fallback: extract form structure, send to LLM
      const formFields = extractFormFields();
      if (formFields.length > 0) {
        const aiResult = await fetchFromBackground("CI_AI_MAP", {
          portalDomain: window.location.hostname,
          fields: formFields,
        });
        if (aiResult?.mappings?.length > 0) {
          sectionMap = { fields: aiResult.mappings };
          isAiFallback = true;
          window.__ciTelemetry?.trackEvent(
            "agent.ai_map.called",
            {
              domain: window.location.hostname,
            },
            { fieldCount: formFields.length },
          );
        }
      }
    }

    if (!sectionMap) {
      console.warn(`[CI] No mapping for section '${section}' on '${portal}'`);
      window.__ciTelemetry?.trackPortalUnknown(window.location.hostname, 0);
      return { success: false, reason: "no_section_mapping" };
    }

    // 2. Fetch Twin data
    const twinEndpoint =
      sectionMap.twinEndpoint?.replace("/twin/", "") ||
      TWIN_ENDPOINT_MAP[section] ||
      "profile";
    let twinData;
    try {
      twinData = await fetchFromBackground("CI_FETCH_TWIN", {
        endpoint: twinEndpoint,
      });
    } catch (twinErr) {
      window.__ciTelemetry?.trackEvent("agent.twin.error", {
        portal,
        section,
        error: twinErr?.message,
      });
      showFillError(
        portal,
        section,
        "We couldn't load your data right now. Please try again in a moment.",
      );
      return { success: false, reason: "twin_fetch_failed" };
    }

    // 3. Map fields to values
    const mapper = window.__ciFieldMapper;
    const simulator = window.__ciInputSimulator;
    let totalFilled = 0;
    let totalFlagged = 0;
    const flaggedFields = [];

    if (sectionMap.repeating) {
      // Repeating section (activities, essays) — fill multiple entries
      const maxEntries = sectionMap.maxEntries || 10;
      const dataArray =
        twinData[
          Object.keys(twinData).find((k) => Array.isArray(twinData[k]))
        ] || [];

      // For essay sections: attempt prompt-matched filling
      if (section === "essays" || section === "writing") {
        const promptMatched = await tryPromptMatchedEssayFill(
          twinData,
          simulator,
        );
        if (promptMatched) {
          totalFilled += promptMatched.filled;
          totalFlagged += promptMatched.flagged;
          promptMatched.flaggedFields.forEach((f) => flaggedFields.push(f));
        } else {
          // Fallback to positional filling
          const entriesToFill = Math.min(dataArray.length, maxEntries);
          for (let i = 0; i < entriesToFill; i++) {
            const mapped = mapper.mapFieldsToValues(sectionMap, twinData, i);
            const { filled, flagged } = fillMappedFields(mapped, simulator);
            totalFilled += filled;
            totalFlagged += flagged;
            mapped
              .filter((f) => f.flagged)
              .forEach((f) => flaggedFields.push(f.label));
          }
        }
      } else {
        const entriesToFill = Math.min(dataArray.length, maxEntries);
        for (let i = 0; i < entriesToFill; i++) {
          const mapped = mapper.mapFieldsToValues(sectionMap, twinData, i);
          const { filled, flagged } = fillMappedFields(mapped, simulator);
          totalFilled += filled;
          totalFlagged += flagged;
          mapped
            .filter((f) => f.flagged)
            .forEach((f) => flaggedFields.push(f.label));
        }
      }
    } else {
      // Non-repeating section — fill once
      const mapped = mapper.mapFieldsToValues(sectionMap, twinData);
      const { filled, flagged } = fillMappedFields(mapped, simulator);
      totalFilled = filled;
      totalFlagged = flagged;
      mapped
        .filter((f) => f.flagged)
        .forEach((f) => flaggedFields.push(f.label));
    }

    // 4. Show preview overlay
    showPreviewOverlay(totalFilled, totalFlagged, portal, section);

    // 5. Report status back to CI
    reportFillStatus(portal, section, totalFilled, totalFlagged, flaggedFields);

    // 6. Track telemetry
    window.__ciTelemetry?.trackFillCompleted(
      portal,
      section,
      totalFilled + totalFlagged,
      totalFilled,
      totalFlagged,
    );
    window.__ciTelemetry?.trackTimeSaved(totalFilled);

    return { success: true, filled: totalFilled, flagged: totalFlagged };
  } catch (err) {
    window.__ciTelemetry?.trackEvent("agent.fill.error", {
      portal,
      section,
      error: err?.message,
    });
    console.error("[CI] Fill failed:", err);
    showFillError(portal, section, err.message);
    return { success: false, reason: err.message };
  }
}

/**
 * Show an error overlay when fill fails.
 */
function showFillError(portal, section, errorMessage) {
  const existing = document.getElementById("ci-overlay-host");
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = "ci-overlay-host";
  const shadow = host.attachShadow({ mode: "closed" });

  const safeMsg = escapeHtml(
    errorMessage || "An unexpected error occurred. Please try again.",
  );
  const safePortal = escapeHtml(portal || "");
  const safeSection = escapeHtml(section || "");

  shadow.innerHTML = `
    <style>
      @keyframes ciFadeInUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes ciShake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-4px)} 75%{transform:translateX(4px)} }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; } }
      .ci-overlay {
        position: fixed; top: 16px; right: 16px; z-index: 2147483647;
        background: linear-gradient(135deg, rgba(20,14,35,0.95), rgba(45,20,25,0.92));
        backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(239,68,68,0.3); border-radius: 14px;
        padding: 18px 22px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px; box-shadow: 0 8px 40px rgba(0,0,0,0.5), 0 0 20px rgba(239,68,68,0.1);
        max-width: 340px; color: rgba(226,232,240,0.95);
        animation: ciFadeInUp 0.4s cubic-bezier(0.16,1,0.3,1);
      }
      .ci-header { display: flex; justify-content: space-between; align-items: center; }
      .ci-title { font-weight: 600; font-size: 15px; color: #f87171; }
      .ci-icon { animation: ciShake 0.5s ease-in-out; display: inline-block; }
      .ci-close { cursor: pointer; font-size: 18px; background: none; border: none;
        color: rgba(200,195,225,0.5); transition: color 0.2s; }
      .ci-close:hover { color: rgba(226,232,240,0.95); }
      .ci-msg { margin: 10px 0; color: rgba(200,195,225,0.75); font-size: 13px; line-height: 1.5; }
      .ci-footer { font-size: 11px; color: rgba(148,163,184,0.45); letter-spacing: 0.03em; }
      .ci-actions { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
      .ci-retry { padding: 6px 16px; font-size: 13px; font-weight: 500;
        background: rgba(253,186,116,0.15); border: 1px solid rgba(253,186,116,0.3);
        color: #fdba74; border-radius: 6px; cursor: pointer; transition: background 0.2s; }
      .ci-retry:hover { background: rgba(253,186,116,0.25); }
      .ci-retry:focus-visible { outline: 2px solid #fdba74; outline-offset: 2px; }
      .ci-close:focus-visible { outline: 2px solid rgba(200,195,225,0.5); outline-offset: 2px; }
      @media (max-width: 640px) {
        .ci-overlay { max-width: 90vw; right: 5vw; left: 5vw; top: 8px; }
      }
    </style>
    <div class="ci-overlay" role="alert">
      <div class="ci-header">
        <span class="ci-title"><span class="ci-icon">&#9888;</span> Fill Failed</span>
        <button class="ci-close" id="ci-close" aria-label="Dismiss error">&times;</button>
      </div>
      <div class="ci-msg">${safeMsg}</div>
      <div class="ci-actions">
        <button class="ci-retry" id="ci-retry" aria-label="Retry form filling">Try Again</button>
      </div>
      <div class="ci-footer">${safePortal} &middot; ${safeSection}</div>
    </div>
  `;

  shadow
    .getElementById("ci-close")
    ?.addEventListener("click", () => host.remove());
  shadow.getElementById("ci-retry")?.addEventListener("click", () => {
    host.remove();
    fillCurrentSection();
  });
  document.body.appendChild(host);
  setTimeout(() => host.remove(), 30000);
}

/**
 * Extract form field structure from the current page for AI mapping.
 * Returns an array of { label, type, name, required } for visible form fields.
 */
function extractFormFields() {
  const fields = [];
  const seen = new Set();

  document.querySelectorAll("input, select, textarea").forEach((el) => {
    // Skip hidden, submit, and button inputs
    if (el.type === "hidden" || el.type === "submit" || el.type === "button")
      return;
    if (!el.offsetParent && el.type !== "hidden") return; // not visible

    const name = el.name || el.id || "";
    if (!name || seen.has(name)) return;
    seen.add(name);

    // Try to find the label
    const label =
      el.labels?.[0]?.textContent?.trim() ||
      el.getAttribute("aria-label") ||
      el.placeholder ||
      el.parentElement?.querySelector("label")?.textContent?.trim() ||
      name;

    fields.push({
      label: label.substring(0, 100),
      type:
        el.tagName === "SELECT"
          ? "select"
          : el.tagName === "TEXTAREA"
            ? "textarea"
            : el.type || "text",
      name,
      required: el.required || el.getAttribute("aria-required") === "true",
    });
  });

  return fields;
}

/**
 * Fill DOM elements from mapped field definitions.
 */
function fillMappedFields(mappedFields, simulator) {
  let filled = 0;
  let flagged = 0;

  for (const field of mappedFields) {
    if (!field.value && field.value !== false) {
      flagged++;
      continue;
    }

    const el = document.querySelector(field.selector);
    if (!el) {
      flagged++;
      continue;
    }

    const success = simulator.fillElement(el, field.value);
    if (success) {
      filled++;
    } else {
      flagged++;
    }

    if (field.flagged) {
      flagged++;
    }
  }

  return { filled, flagged };
}

/**
 * Send a request to the service worker and unwrap the response.
 */
function fetchFromBackground(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.success) {
        reject(new Error(response?.error || `${type} failed`));
        return;
      }
      resolve(response.data);
    });
  });
}

/**
 * Report fill status to CI backend (fire-and-forget).
 */
function reportFillStatus(portal, section, filled, flagged, flaggedFields) {
  chrome.runtime.sendMessage({
    type: "CI_POST_STATUS",
    payload: {
      portal,
      section,
      status: flagged === 0 ? "draft_filled" : "reviewed",
      fieldsTotal: filled + flagged,
      fieldsFilled: filled,
      flaggedFields,
      agentType: "extension",
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Show a preview overlay summarizing fill results.
 * Uses Shadow DOM to isolate styles from the portal page.
 */
function showPreviewOverlay(filled, flagged, portal, section) {
  const existing = document.getElementById("ci-overlay-host");
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = "ci-overlay-host";
  const shadow = host.attachShadow({ mode: "closed" });

  const timeSaved = Math.round((filled * 30) / 60); // 30 sec per field

  shadow.innerHTML = `
    <style>
      @keyframes ciFadeInUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes ciPulse { 0%,100%{opacity:0.6} 50%{opacity:1} }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; } }
      .ci-overlay {
        position: fixed; top: 16px; right: 16px; z-index: 2147483647;
        background: linear-gradient(135deg, rgba(20,14,35,0.95), rgba(30,22,48,0.92));
        backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(253,186,116,0.15); border-radius: 14px;
        padding: 18px 22px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px; box-shadow: 0 8px 40px rgba(0,0,0,0.5), 0 0 20px rgba(253,186,116,0.08);
        max-width: 340px; color: rgba(226,232,240,0.95);
        animation: ciFadeInUp 0.4s cubic-bezier(0.16,1,0.3,1);
      }
      .ci-header { display: flex; justify-content: space-between; align-items: center; }
      .ci-title { font-weight: 600; font-size: 15px; color: #fdba74; }
      .ci-close { cursor: pointer; font-size: 18px; background: none; border: none;
        color: rgba(200,195,225,0.5); transition: color 0.2s; }
      .ci-close:hover { color: rgba(226,232,240,0.95); }
      .ci-stats { margin: 10px 0; }
      .ci-stat { margin: 4px 0; font-size: 13px; }
      .ci-filled { color: #4ade80; }
      .ci-flagged { color: #fbbf24; }
      .ci-footer { margin-top: 10px; font-size: 11px; color: rgba(148,163,184,0.45); letter-spacing: 0.03em; }
      .ci-time { color: #fdba74; font-weight: 500; animation: ciPulse 3s ease-in-out 1; }
    </style>
    <div class="ci-overlay" role="status">
      <div class="ci-header">
        <span class="ci-title">&#9881; CollegeInsight Autofill</span>
        <button class="ci-close" id="ci-close" aria-label="Dismiss">&times;</button>
      </div>
      <div class="ci-stats">
        <div class="ci-stat ci-filled">&#10003; ${filled} fields filled</div>
        ${flagged > 0 ? `<div class="ci-stat ci-flagged">&#9888; ${flagged} need review</div>` : ""}
      </div>
      <div class="ci-footer">
        ${escapeHtml(portal)} &middot; ${escapeHtml(section)} &middot; <span class="ci-time">~${timeSaved} min saved</span>
      </div>
    </div>
  `;

  shadow
    .getElementById("ci-close")
    .addEventListener("click", () => host.remove());
  document.body.appendChild(host);

  // Auto-dismiss after 30 seconds
  setTimeout(() => host.remove(), 30000);
}

// Listen for fill requests from popup or CI web app
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "CI_FILL_SECTION") {
    fillCurrentSection().then(sendResponse);
    return true;
  }
  return false;
});

// ════════════════════════════════════════════════════════════════
// "Fill All Sections" — Sequential multi-section fill flow
// Triggered from CI's Application Prep page via ci-bridge
// ════════════════════════════════════════════════════════════════

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

/**
 * Fill all sections of a portal sequentially.
 * Navigates to each section, fills, pauses for student visibility, then moves on.
 */
async function fillAllSections() {
  const portal = window.__ciPortal;
  if (!portal) return { success: false, reason: "not_on_portal" };

  const sections = portal === "common_app" ? COMMON_APP_SECTIONS : [];
  if (sections.length === 0) {
    return { success: false, reason: "no_fill_all_config" };
  }

  const results = [];
  showFillAllProgress(0, sections.length, "Starting...");

  for (let i = 0; i < sections.length; i++) {
    // Check if user clicked "Stop filling"
    if (window.__ciFillAllAborted) {
      results.push({
        section: sections[i].key,
        label: sections[i].label,
        success: false,
        reason: "aborted",
        filled: 0,
        flagged: 0,
      });
      break;
    }

    const sec = sections[i];
    showFillAllProgress(i, sections.length, `Filling ${sec.label}...`);

    // Navigate to section
    const baseUrl = window.location.origin;
    window.location.href = `${baseUrl}${sec.urlPath}`;

    // Wait for page to load and fields to render
    await waitForPageReady();

    // Fill the current section
    const result = await fillCurrentSection();
    results.push({
      section: sec.key,
      label: sec.label,
      ...result,
    });

    // Pause for student to see what was filled
    await delay(2000);
  }

  // Show final summary
  const totalFilled = results.reduce((s, r) => s + (r.filled || 0), 0);
  const totalFlagged = results.reduce((s, r) => s + (r.flagged || 0), 0);
  showFillAllSummary(results, totalFilled, totalFlagged);

  // Report batch status
  reportBatchStatus(portal, results);

  // Notify CI web app that fill is complete
  chrome.runtime.sendMessage({
    type: "CI_FILL_ALL_COMPLETE",
    results,
    totalFilled,
    totalFlagged,
  });

  return { success: true, results, totalFilled, totalFlagged };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPageReady() {
  return new Promise((resolve) => {
    let checks = 0;
    const interval = setInterval(() => {
      checks++;
      // Check if form fields have rendered
      const hasFields =
        document.querySelectorAll(
          'input[id^="text_ques_"], textarea[id^="text_ques_"], input[type="checkbox"][id*="checkboxList"]',
        ).length > 0;
      if (hasFields || checks > 20) {
        clearInterval(interval);
        resolve();
      }
    }, 500);
  });
}

function showFillAllProgress(current, total, message) {
  const existing = document.getElementById("ci-fill-all-progress");
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = "ci-fill-all-progress";
  const shadow = host.attachShadow({ mode: "closed" });

  const pct = total > 0 ? Math.round(((current + 1) / total) * 100) : 0;

  shadow.innerHTML = `
    <style>
      @keyframes ciFadeInUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes ciBarPulse { 0%,100%{box-shadow: 0 0 4px rgba(253,186,116,0.3)} 50%{box-shadow: 0 0 12px rgba(253,186,116,0.6)} }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; } }
      .ci-progress {
        position: fixed; top: 16px; right: 16px; z-index: 2147483647;
        background: linear-gradient(135deg, rgba(20,14,35,0.95), rgba(30,22,48,0.92));
        backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(253,186,116,0.15); border-radius: 14px;
        padding: 18px 22px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px; box-shadow: 0 8px 40px rgba(0,0,0,0.5), 0 0 20px rgba(253,186,116,0.08);
        width: 310px; color: rgba(226,232,240,0.95);
        animation: ciFadeInUp 0.4s cubic-bezier(0.16,1,0.3,1);
      }
      .ci-title { font-weight: 600; font-size: 15px; margin-bottom: 10px; color: #fdba74; }
      .ci-bar-bg { background: rgba(255,255,255,0.06); border-radius: 6px; height: 8px; margin: 8px 0; overflow: hidden; }
      .ci-bar { background: linear-gradient(90deg, #f97316, #fdba74); border-radius: 6px; height: 8px;
        transition: width 0.5s cubic-bezier(0.16,1,0.3,1); animation: ciBarPulse 2s ease-in-out infinite; }
      .ci-msg { color: rgba(200,195,225,0.65); font-size: 13px; }
      .ci-abort { margin-top: 10px; font-size: 12px; color: rgba(248,113,113,0.8); cursor: pointer;
        border: none; background: none; transition: color 0.2s; padding: 0; }
      .ci-abort:hover { color: #f87171; }
    </style>
    <div class="ci-progress">
      <div class="ci-title">&#9881; Filling Application</div>
      <div class="ci-bar-bg"><div class="ci-bar" style="width: ${pct}%"></div></div>
      <div class="ci-msg">${message} (${current + 1}/${total})</div>
      <button class="ci-abort" id="ci-abort" aria-label="Stop filling application">Stop filling</button>
    </div>
  `;

  shadow.getElementById("ci-abort")?.addEventListener("click", () => {
    window.__ciFillAllAborted = true;
    host.remove();
  });

  document.body.appendChild(host);
}

function showFillAllSummary(results, totalFilled, totalFlagged) {
  const existing = document.getElementById("ci-fill-all-progress");
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = "ci-fill-all-progress";
  const shadow = host.attachShadow({ mode: "closed" });

  const timeSaved = Math.round((totalFilled * 30) / 60);
  const sectionLines = results
    .map((r) => {
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
            ? escapeHtml(r.reason)
            : `${r.filled || 0} fields`;
      const color =
        r.reason === "aborted"
          ? "#fbbf24"
          : r.success === false
            ? "#f87171"
            : r.filled > 0
              ? "#4ade80"
              : "rgba(148,163,184,0.45)";
      return `<div style="color:${color}">${icon} ${escapeHtml(r.label)}: ${detail}</div>`;
    })
    .join("");

  shadow.innerHTML = `
    <style>
      @keyframes ciFadeInUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes ciSuccessPop { 0%{transform:scale(0.9);opacity:0} 60%{transform:scale(1.02)} 100%{transform:scale(1);opacity:1} }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; } }
      .ci-summary {
        position: fixed; top: 16px; right: 16px; z-index: 2147483647;
        background: linear-gradient(135deg, rgba(20,14,35,0.95), rgba(15,30,25,0.92));
        backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(74,222,128,0.2); border-radius: 14px;
        padding: 18px 22px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px; box-shadow: 0 8px 40px rgba(0,0,0,0.5), 0 0 20px rgba(74,222,128,0.08);
        width: 330px; color: rgba(226,232,240,0.95);
        animation: ciSuccessPop 0.5s cubic-bezier(0.34,1.56,0.64,1);
      }
      .ci-title { font-weight: 600; font-size: 15px; color: #4ade80; margin-bottom: 10px; }
      .ci-sections { font-size: 13px; line-height: 1.8; margin: 8px 0; }
      .ci-total { font-weight: 600; margin-top: 10px; color: rgba(226,232,240,0.95); }
      .ci-time { color: #fdba74; font-size: 12px; margin-top: 4px; }
      .ci-close { cursor: pointer; font-size: 18px; background: none; border: none;
        color: rgba(200,195,225,0.5); float: right; transition: color 0.2s; }
      .ci-close:hover { color: rgba(226,232,240,0.95); }
    </style>
    <div class="ci-summary" role="status">
      <button class="ci-close" id="ci-close" aria-label="Dismiss">&times;</button>
      <div class="ci-title">&#10024; Fill Complete!</div>
      <div class="ci-sections">${sectionLines}</div>
      <div class="ci-total">${totalFilled} fields filled, ${totalFlagged} need review</div>
      <div class="ci-time">~${timeSaved} minutes saved</div>
    </div>
  `;

  shadow
    .getElementById("ci-close")
    ?.addEventListener("click", () => host.remove());
  document.body.appendChild(host);
  setTimeout(() => host.remove(), 60000);
}

function reportBatchStatus(portal, results) {
  const sections = results.map((r) => ({
    section: r.section,
    fieldsTotal: (r.filled || 0) + (r.flagged || 0),
    fieldsFilled: r.filled || 0,
    status:
      r.flagged === 0 && r.filled > 0
        ? "complete"
        : r.filled > 0
          ? "partial"
          : "skipped",
  }));

  chrome.runtime.sendMessage({
    type: "CI_POST_STATUS",
    payload: {
      portal,
      sections,
      totalFilled: results.reduce((s, r) => s + (r.filled || 0), 0),
      totalFlagged: results.reduce((s, r) => s + (r.flagged || 0), 0),
      agentType: "extension",
      fillMode: "fill_all",
      timestamp: new Date().toISOString(),
    },
  });
}

// Check if Fill All was requested (from CI web app via service worker)
chrome.storage.local.get(["ciFillAll"], (data) => {
  if (data.ciFillAll && !window.__ciFillAllStarted) {
    window.__ciFillAllStarted = true;
    chrome.storage.local.remove("ciFillAll");
    fillAllSections();
  }
});

// Expose for direct invocation
window.__ciFill = fillCurrentSection;
window.__ciFillAll = fillAllSections;

/**
 * Prompt-matched essay filling.
 * Scans the page for text areas with visible prompt labels,
 * matches them against stored essay drafts by prompt text similarity,
 * and fills the correct draft into the correct text box.
 *
 * @returns {{ filled, flagged, flaggedFields }|null} — null if matching not possible
 */
async function tryPromptMatchedEssayFill(twinData, simulator) {
  // Find all text areas on the page (essay inputs)
  const textAreas = document.querySelectorAll(
    'textarea, [contenteditable="true"], [role="textbox"]',
  );
  if (textAreas.length === 0) return null;

  // Get the essays from twin data
  const essays = twinData?.essays || twinData?.Essays || [];
  if (!Array.isArray(essays) || essays.length === 0) return null;

  // Extract visible prompt text near each text area
  const pagePrompts = [];
  for (const ta of textAreas) {
    const promptText = extractNearbyPromptText(ta);
    if (promptText) {
      pagePrompts.push({ element: ta, promptText });
    }
  }
  if (pagePrompts.length === 0) return null;

  // Build a map of essay drafts keyed by prompt text
  const draftsByPrompt = [];
  for (const essay of essays) {
    if (essay.promptText && essay.content?.trim()) {
      draftsByPrompt.push({
        promptText: essay.promptText,
        content: essay.content,
      });
    }
  }
  if (draftsByPrompt.length === 0) return null;

  let filled = 0;
  let flagged = 0;
  const flaggedFields = [];

  for (const pp of pagePrompts) {
    // Find best-matching draft by prompt similarity
    let bestMatch = null;
    let bestScore = 0;

    for (const draft of draftsByPrompt) {
      const score = promptSimilarity(pp.promptText, draft.promptText);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = draft;
      }
    }

    if (bestMatch && bestScore > 0.3) {
      // Fill the text area with the matched draft
      try {
        simulator.simulateTyping(pp.element, bestMatch.content);
        filled++;
      } catch {
        flagged++;
        flaggedFields.push(pp.promptText.slice(0, 60));
      }
    } else {
      flagged++;
      flaggedFields.push(pp.promptText.slice(0, 60));
    }
  }

  window.__ciTelemetry?.trackEvent("agent.essay.prompt_matched", {
    totalPrompts: pagePrompts.length,
    filled,
    flagged,
  });

  return { filled, flagged, flaggedFields };
}

/**
 * Extract visible prompt/label text near a textarea element.
 * Looks for preceding label, heading, or paragraph containing prompt text.
 */
function extractNearbyPromptText(element) {
  // Check aria-label
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.length > 10) return ariaLabel;

  // Check preceding sibling or parent's children for labels
  const parent =
    element.closest(
      ".form-group, .field-container, .question, [class*='essay'], [class*='prompt']",
    ) || element.parentElement;
  if (parent) {
    const labels = parent.querySelectorAll(
      "label, h3, h4, p, .prompt-text, .question-text",
    );
    for (const label of labels) {
      const text = label.textContent?.trim();
      if (text && text.length > 15 && text.length < 2000) return text;
    }
  }

  // Check explicit <label> association
  const id = element.id;
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label?.textContent?.trim()?.length > 10)
      return label.textContent.trim();
  }

  return null;
}

/**
 * Compute similarity between two prompt texts (0-1).
 * Uses normalized keyword overlap.
 */
function promptSimilarity(textA, textB) {
  if (!textA || !textB) return 0;
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "has",
    "have",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "shall",
    "can",
    "not",
    "this",
    "that",
    "you",
    "your",
    "we",
    "our",
    "they",
    "their",
    "what",
    "which",
    "who",
  ]);
  const tokenize = (text) =>
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !stopWords.has(w)),
    );
  const setA = tokenize(textA);
  const setB = tokenize(textB);
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}
