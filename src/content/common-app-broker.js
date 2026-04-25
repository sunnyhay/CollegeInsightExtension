/**
 * common-app-broker.js — Content script for apply.commonapp.org.
 *
 * Lives in the user's Common App tab. Responsibilities:
 *   1. On load, capture the Cognito session triple (refreshToken, deviceKey, idToken)
 *      from window.localStorage and ship it to the service worker for caching.
 *   2. Listen for chrome.runtime messages from the service worker (originating from
 *      the CollegeInsight SPA) and execute Common App API calls FROM THIS ORIGIN.
 *      api25.commonapp.org enforces an Origin allowlist (only https://apply.commonapp.org),
 *      so the actual fetch() must run here, not in the service worker.
 *   3. Refresh the idToken via cognito-idp before each batch if expired.
 *
 * Telemetry events: agent.ca.capture, agent.ca.refresh, agent.ca.fill,
 *   agent.ca.error (mirrors existing agent.fill.* naming).
 *
 * Discovered in POCs #1–#4 (April 24, 2026). See:
 *   - CollegeMatchFrontend/scripts/common-app/notes.md §3, §3a, §3b, §3c
 *   - CollegeMatchFrontend/docs/gen6/APPLICATION_ACCELERATOR_DESIGN.md
 */

(() => {
  const COGNITO_CLIENT_ID = "7nlsd88gsm2rlvu45jv7g8edh8";
  const COGNITO_REGION = "us-west-2";
  const CA_API_BASE = "https://api25.commonapp.org";
  const CA_API_KEY = "tYFvpgKw3GaxrwoztllAc2j5bekLdMF25aayCxwx";
  const COGNITO_URL = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;
  const LS_PREFIX = `CognitoIdentityServiceProvider.${COGNITO_CLIENT_ID}.`;
  const ID_TOKEN_REFRESH_MARGIN_SEC = 300; // refresh if <5 min remaining

  /** Read the current Cognito session from this page's localStorage. */
  function readSessionFromLocalStorage() {
    const username = localStorage.getItem(`${LS_PREFIX}LastAuthUser`);
    if (!username) return null;
    const base = `${LS_PREFIX}${username}.`;
    const refreshToken = localStorage.getItem(`${base}refreshToken`);
    const deviceKey = localStorage.getItem(`${base}deviceKey`);
    const idToken = localStorage.getItem(`${base}idToken`);
    if (!refreshToken || !deviceKey) return null;
    return { username, refreshToken, deviceKey, idToken: idToken || null };
  }

  /** JWT payload decode (no signature verification — used only to read exp). */
  function jwtPayload(token) {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length < 2) return null;
    try {
      return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    } catch {
      return null;
    }
  }

  /** Cognito InitiateAuth + REFRESH_TOKEN_AUTH. DEVICE_KEY required by this user pool. */
  async function refreshIdToken({ refreshToken, deviceKey }) {
    const resp = await fetch(COGNITO_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: COGNITO_CLIENT_ID,
        AuthParameters: {
          REFRESH_TOKEN: refreshToken,
          DEVICE_KEY: deviceKey,
        },
      }),
      credentials: "omit",
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(
        `cognito_refresh_failed:${resp.status}:${body.slice(0, 200)}`,
      );
    }
    const data = await resp.json();
    const auth = data?.AuthenticationResult;
    if (!auth?.IdToken) throw new Error("cognito_no_id_token");
    return {
      idToken: auth.IdToken,
      accessToken: auth.AccessToken,
      // Refresh token is reused; AuthenticationResult.RefreshToken is usually absent.
      refreshToken: auth.RefreshToken || refreshToken,
      expiresIn: auth.ExpiresIn || 3600,
    };
  }

  /**
   * Ensure we have a fresh idToken. Reads from localStorage (the SPA may have
   * just refreshed it itself) before falling back to a manual refresh.
   */
  async function getFreshIdToken() {
    const session = readSessionFromLocalStorage();
    if (!session) throw new Error("ca_not_signed_in");

    const payload = jwtPayload(session.idToken);
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload?.exp && payload.exp - nowSec > ID_TOKEN_REFRESH_MARGIN_SEC) {
      return { idToken: session.idToken, refreshed: false };
    }

    const refreshed = await refreshIdToken(session);
    // Keep localStorage in sync so the SPA reuses our fresh token too.
    const username = session.username;
    const base = `${LS_PREFIX}${username}.`;
    localStorage.setItem(`${base}idToken`, refreshed.idToken);
    if (refreshed.accessToken)
      localStorage.setItem(`${base}accessToken`, refreshed.accessToken);
    return { idToken: refreshed.idToken, refreshed: true };
  }

  /** Common App API call. Must run from this origin to satisfy the api25 Origin allowlist. */
  async function caApi(method, path, body, idToken) {
    const resp = await fetch(`${CA_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: idToken,
        "X-APi-Key": CA_API_KEY,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "omit",
    });
    const text = await resp.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!resp.ok) {
      throw new Error(
        `ca_api_error:${resp.status}:${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`,
      );
    }
    return parsed;
  }

  // --- High-level operations exposed to the SPA via the service worker ---

  async function listMyColleges(idToken) {
    return caApi("GET", "/applicant/mycolleges", undefined, idToken);
  }

  async function addColleges(memberIds, idToken) {
    return caApi(
      "POST",
      "/applicant/mycolleges",
      { MemberIds: memberIds },
      idToken,
    );
  }

  async function removeCollege(memberId, idToken) {
    return caApi(
      "DELETE",
      `/applicant/mycolleges/${memberId}`,
      undefined,
      idToken,
    );
  }

  async function saveAnswers(answers, idToken) {
    // answers: [{questionId, response, memberQuestionTemplateId?}, ...]
    const payload = {
      Answers: answers.map((a) => ({
        questionId: a.questionId,
        response: a.response,
        memberQuestionTemplateId: a.memberQuestionTemplateId ?? null,
      })),
    };
    return caApi("POST", "/answer/v2", payload, idToken);
  }

  // --- Initial session capture on page load ---

  function captureAndReportSession() {
    const session = readSessionFromLocalStorage();
    if (!session) return;
    chrome.runtime.sendMessage({
      type: "CA_SESSION_CAPTURED",
      // Don't ship tokens to SW long-term — only the metadata it needs to know we're connected.
      // Future enhancement: SW can request fresh tokens via CA_REQUEST_REFRESH if needed for
      // cross-tab fills.
      meta: {
        username: session.username,
        hasRefreshToken: !!session.refreshToken,
        hasDeviceKey: !!session.deviceKey,
        idTokenExp: jwtPayload(session.idToken)?.exp || null,
      },
    });
  }

  // --- Message handler from service worker ---

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;
    if (!message.type.startsWith("CA_")) return;

    (async () => {
      try {
        const { idToken, refreshed } = await getFreshIdToken();
        let result;
        switch (message.type) {
          case "CA_LIST_COLLEGES":
            result = await listMyColleges(idToken);
            break;
          case "CA_ADD_COLLEGES":
            result = await addColleges(message.memberIds, idToken);
            break;
          case "CA_REMOVE_COLLEGE":
            result = await removeCollege(message.memberId, idToken);
            break;
          case "CA_SAVE_ANSWERS":
            result = await saveAnswers(message.answers, idToken);
            break;
          case "CA_PING":
            result = { connected: true, idTokenRefreshed: refreshed };
            break;
          default:
            sendResponse({
              success: false,
              error: `unknown_ca_message:${message.type}`,
            });
            return;
        }
        sendResponse({ success: true, refreshed, result });
      } catch (err) {
        sendResponse({ success: false, error: String(err?.message || err) });
      }
    })();
    return true; // async response
  });

  // Run once on load, and again whenever Cognito likely rotated the token in this tab.
  captureAndReportSession();
  window.addEventListener("storage", (e) => {
    if (e.key && e.key.startsWith(LS_PREFIX) && e.key.endsWith(".idToken")) {
      captureAndReportSession();
    }
  });
})();
