/**
 * ci-api.js — CI Backend API client for content scripts.
 * Communicates with the service worker which holds the auth token.
 */

/**
 * Fetch Twin data from the CI backend via the service worker.
 * @param {"profile"|"activities"|"essays"|"financial"|"colleges"} endpoint
 * @returns {Promise<object>} Twin data
 */
async function fetchTwin(endpoint) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "CI_FETCH_TWIN", endpoint },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.success) {
          reject(new Error(response?.error || "Failed to fetch Twin data"));
          return;
        }
        resolve(response.data);
      },
    );
  });
}

/**
 * Fetch portal field mapping from the CI backend.
 * @param {string} portal - Portal name (e.g., "common_app", "uc_app")
 * @returns {Promise<object>} Portal map with sections and fields
 */
async function fetchPortalMap(portal) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "CI_FETCH_PORTAL_MAP", portal },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.success) {
          reject(new Error(response?.error || "Failed to fetch portal map"));
          return;
        }
        resolve(response.data);
      },
    );
  });
}

/**
 * Post form-filling status back to CI backend.
 * @param {object} statusPayload - { portal, section, status, fieldsTotal, fieldsFilled, agentType }
 * @returns {Promise<object>}
 */
async function postStatus(statusPayload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "CI_POST_STATUS", payload: statusPayload },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.success) {
          reject(new Error(response?.error || "Failed to post status"));
          return;
        }
        resolve(response.data);
      },
    );
  });
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
  fetchTwin,
  fetchPortalMap,
  postStatus,
  isAuthenticated,
};
