/**
 * ci-api.js — CI Backend API client for content scripts.
 * Communicates with the service worker which holds the auth token.
 */

/** Send a message to the service worker with a timeout. */
function sendMessageWithTimeout(message, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("ci_error:timeout"));
    }, timeoutMs);

    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.success) {
        reject(new Error(response?.error || "ci_error:service_error"));
        return;
      }
      resolve(response.data);
    });
  });
}

/**
 * Fetch Compass data from the CI backend via the service worker.
 * Includes 1 retry with 2s delay on service errors.
 * @param {"profile"|"activities"|"essays"|"financial"|"colleges"} endpoint
 * @returns {Promise<object>} Compass data
 */
async function fetchCompass(endpoint) {
  try {
    return await sendMessageWithTimeout({ type: "CI_FETCH_COMPASS", endpoint });
  } catch (err) {
    // Retry once on service errors (5xx), not auth or timeout
    if (err.message?.includes("service_error")) {
      await new Promise((r) => setTimeout(r, 2000));
      return await sendMessageWithTimeout({ type: "CI_FETCH_COMPASS", endpoint });
    }
    throw err;
  }
}

/**
 * Fetch portal field mapping from the CI backend.
 * @param {string} portal - Portal name (e.g., "common_app", "uc_app")
 * @returns {Promise<object>} Portal map with sections and fields
 */
async function fetchPortalMap(portal) {
  return sendMessageWithTimeout({ type: "CI_FETCH_PORTAL_MAP", portal });
}

/**
 * Post form-filling status back to CI backend.
 * @param {object} statusPayload - { portal, section, status, fieldsTotal, fieldsFilled, agentType }
 * @returns {Promise<object>}
 */
async function postStatus(statusPayload) {
  return sendMessageWithTimeout({ type: "CI_POST_STATUS", payload: statusPayload });
}

/**
 * Check if the user is authenticated with CI.
 * @returns {Promise<boolean>}
 */
async function isAuthenticated() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "CI_GET_STATUS" }, (response) => {
      resolve(response?.authenticated === true);
    });
  });
}

// Expose to other content scripts
window.__ciApi = {
  fetchCompass,
  fetchPortalMap,
  postStatus,
  isAuthenticated,
};
