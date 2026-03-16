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

/**
 * Main entry point: fill the current portal section.
 */
async function fillCurrentSection() {
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
    const twinData = await fetchFromBackground("CI_FETCH_TWIN", {
      endpoint: twinEndpoint,
    });

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
    console.error("[CI] Fill failed:", err);
    return { success: false, reason: err.message };
  }
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
      .ci-overlay {
        position: fixed; top: 12px; right: 12px; z-index: 2147483647;
        background: #fff; border: 2px solid #4f46e5; border-radius: 12px;
        padding: 16px 20px; font-family: system-ui, sans-serif; font-size: 14px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.15); max-width: 340px; color: #1e1e2e;
      }
      .ci-header { display: flex; justify-content: space-between; align-items: center; }
      .ci-title { font-weight: 600; font-size: 15px; }
      .ci-close { cursor: pointer; font-size: 18px; background: none; border: none; color: #888; }
      .ci-stats { margin: 10px 0; }
      .ci-stat { margin: 4px 0; }
      .ci-filled { color: #16a34a; }
      .ci-flagged { color: #d97706; }
      .ci-footer { margin-top: 10px; font-size: 12px; color: #888; }
    </style>
    <div class="ci-overlay">
      <div class="ci-header">
        <span class="ci-title">CollegeInsight Autofill</span>
        <button class="ci-close" id="ci-close">&times;</button>
      </div>
      <div class="ci-stats">
        <div class="ci-stat ci-filled">&#10003; ${filled} fields filled</div>
        ${flagged > 0 ? `<div class="ci-stat ci-flagged">&#9888; ${flagged} need review</div>` : ""}
      </div>
      <div class="ci-footer">
        ${portal} &middot; ${section} &middot; ~${timeSaved} min saved
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
      .ci-progress {
        position: fixed; top: 12px; right: 12px; z-index: 2147483647;
        background: #fff; border: 2px solid #4f46e5; border-radius: 12px;
        padding: 16px 20px; font-family: system-ui, sans-serif; font-size: 14px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.15); width: 300px; color: #1e1e2e;
      }
      .ci-title { font-weight: 600; font-size: 15px; margin-bottom: 8px; }
      .ci-bar-bg { background: #e2e8f0; border-radius: 4px; height: 8px; margin: 8px 0; }
      .ci-bar { background: #4f46e5; border-radius: 4px; height: 8px; transition: width 0.3s; }
      .ci-msg { color: #64748b; font-size: 13px; }
      .ci-abort { margin-top: 8px; font-size: 12px; color: #ef4444; cursor: pointer; border: none; background: none; }
    </style>
    <div class="ci-progress">
      <div class="ci-title">CollegeInsight — Filling Application</div>
      <div class="ci-bar-bg"><div class="ci-bar" style="width: ${pct}%"></div></div>
      <div class="ci-msg">${message} (${current + 1}/${total})</div>
      <button class="ci-abort" id="ci-abort">Stop filling</button>
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
      const icon = r.filled > 0 ? "✓" : "—";
      return `<div>${icon} ${r.label}: ${r.filled || 0} fields</div>`;
    })
    .join("");

  shadow.innerHTML = `
    <style>
      .ci-summary {
        position: fixed; top: 12px; right: 12px; z-index: 2147483647;
        background: #fff; border: 2px solid #16a34a; border-radius: 12px;
        padding: 16px 20px; font-family: system-ui, sans-serif; font-size: 14px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.15); width: 320px; color: #1e1e2e;
      }
      .ci-title { font-weight: 600; font-size: 15px; color: #16a34a; margin-bottom: 8px; }
      .ci-sections { font-size: 13px; line-height: 1.8; margin: 8px 0; }
      .ci-total { font-weight: 600; margin-top: 8px; }
      .ci-time { color: #64748b; font-size: 12px; }
      .ci-close { cursor: pointer; font-size: 18px; background: none; border: none; color: #888; float: right; }
    </style>
    <div class="ci-summary">
      <button class="ci-close" id="ci-close">&times;</button>
      <div class="ci-title">Application Fill Complete!</div>
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
