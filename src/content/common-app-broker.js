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
  // Phase 1 #1.6: dynamic key resolution. Module loaded by manifest before us.
  const keyExtractor =
    (typeof window !== "undefined" && window.__ciApiKeyExtractor) || null;
  const COGNITO_URL = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;
  const LS_PREFIX = `CognitoIdentityServiceProvider.${COGNITO_CLIENT_ID}.`;
  const ID_TOKEN_REFRESH_MARGIN_SEC = 300; // refresh if <5 min remaining

  /** Lightweight telemetry forward to SW (avoids duplicating App Insights wire format). */
  function emit(name, props) {
    try {
      chrome.runtime.sendMessage({ type: "AGENT_TELEMETRY", name, props });
    } catch {
      /* SW may be transient; drop silently */
    }
  }

  /** Resolve current X-APi-Key. Fails closed when extractor not loaded. */
  async function getApiKey(forceRefresh) {
    if (!keyExtractor) {
      // No extractor module — fail closed (Phase 1 #1.6 contract).
      return { key: null, extractionFailed: true };
    }
    return keyExtractor.resolveApiKey({ forceRefresh, emit });
  }

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

  /** Cognito InitiateAuth + REFRESH_TOKEN_AUTH. DEVICE_KEY required by this user pool.
   *  Throws structured Error whose .message is one of:
   *    cognito_no_id_token | token_expired | device_revoked | cognito_refresh_failed:<status>
   */
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
      // Classify by Cognito message body, not exception name (Round 2 #5).
      // Cognito does not reliably distinguish device-eviction from refresh-revocation;
      // both surface as NotAuthorizedException + "Invalid Refresh Token". Treat as
      // device_revoked when we have a deviceKey on file (re-capture flow needed),
      // otherwise token_expired.
      if (/Refresh Token has expired/i.test(body)) {
        throw new Error("token_expired");
      }
      if (
        /Invalid Refresh Token/i.test(body) ||
        /NotAuthorizedException/i.test(body)
      ) {
        throw new Error(deviceKey ? "device_revoked" : "token_expired");
      }
      throw new Error(`cognito_refresh_failed:${resp.status}`);
    }
    const data = await resp.json();
    const auth = data && data.AuthenticationResult;
    if (!auth || !auth.IdToken) throw new Error("cognito_no_id_token");
    return {
      idToken: auth.IdToken,
      accessToken: auth.AccessToken,
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

  /** Common App API call. Must run from this origin to satisfy the api25 Origin allowlist.
   *  On 401/403 (likely apikey_rotated), force-refresh the key and retry once. */
  async function caApi(method, path, body, idToken, attempt) {
    const tries = attempt || 0;
    const { key: apiKey, extractionFailed } = await getApiKey(tries > 0);
    if (!apiKey) {
      // Extractor failed closed — do not attempt the API call.
      throw new Error("apikey_extraction_failed");
    }
    const resp = await fetch(`${CA_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: idToken,
        "X-APi-Key": apiKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "omit",
    });
    if ((resp.status === 401 || resp.status === 403) && tries === 0) {
      // Possible apikey rotation — retry once with forced extraction.
      return caApi(method, path, body, idToken, tries + 1);
    }
    const text = await resp.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!resp.ok) {
      // After one retry, treat persistent 401/403 as apikey_rotated unless
      // extraction itself failed (in which case fail-closed signals to broker).
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(
          extractionFailed ? "apikey_extraction_failed" : "apikey_rotated",
        );
      }
      throw new Error(`ca_api_error:${resp.status}`);
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

  // ── POC #6 read-existing-answers operations ──────────────────────────
  //
  // The universal answer-read endpoint discovered May 14, 2026:
  //
  //   GET /answer/sections/<sectionId>
  //
  // Same endpoint serves both shared sections (small int IDs, e.g.
  // 11=Personal Information, 26=Household, 232=Activities) and per-college
  // sections (≥1000 IDs unique to each college, e.g. 6717=Cornell/Academics).
  //
  // Full discovery + 18-field round-trip validation in POC #6 (see
  // CollegeMatchFrontend/docs/gen6/APPLICATION_ACCELERATOR_DESIGN.md §9).
  //
  // The foundation/per-college helpers below fan out across the relevant
  // sectionIds with a concurrency cap of 4 (per §8.0.14 Q.8) so a 10-college
  // user's full read completes in ~1-3 seconds without tripping CA's rate
  // limiter. CA's own SPA fans out ≥6 parallel GETs on dashboard load
  // without throttling, so 4 is safely conservative.

  /** GET answers for a single section. Returns the raw Answer[] array. */
  async function listSectionAnswers(sectionId, idToken) {
    return caApi("GET", `/answer/sections/${sectionId}`, undefined, idToken);
  }

  /** GET the section structure for a screen (datacatalog metadata).
   *  Returns an array of `{id, name, order, screenId, hasDefaultVisibleQuestions}`. */
  async function listScreenSections(screenId, idToken) {
    return caApi(
      "GET",
      `/datacatalog/screens/${screenId}/sections`,
      undefined,
      idToken,
    );
  }

  /** GET the screens for one of the user's colleges (datacatalog metadata).
   *  Returns `[{id: screenId, screenType, sections: [sectionId], ...}, ...]`.
   *  We filter to screenType ∈ {2, 3} elsewhere (Questions + Writing Supplement). */
  async function listMemberScreens(memberId, idToken) {
    return caApi(
      "GET",
      `/datacatalog/members/${memberId}/screens`,
      undefined,
      idToken,
    );
  }

  /** Foundation screen IDs the Accelerator's MVP fills. Excludes
   *  Courses & Grades (screenId 13) which uses a separate endpoint shape
   *  (`/answer/CoursesAndGrades`) and is out of scope for MVP. */
  const FOUNDATION_SCREEN_IDS = [
    3, // Profile
    5, // Family
    4, // Education
    2, // Testing
    7, // Activities
    6, // Writing
  ];

  /** Run `tasks` (array of `() => Promise`) with a concurrency cap. Returns
   *  results in original task order. Failures resolve to `{ ok: false,
   *  error }` rather than rejecting, so a single section's failure doesn't
   *  abort the whole read. */
  async function runWithConcurrency(tasks, concurrency) {
    const results = new Array(tasks.length);
    let nextIndex = 0;
    async function worker() {
      while (true) {
        const i = nextIndex++;
        if (i >= tasks.length) return;
        try {
          results[i] = { ok: true, value: await tasks[i]() };
        } catch (err) {
          results[i] = { ok: false, error: err?.message || String(err) };
        }
      }
    }
    const n = Math.min(concurrency, tasks.length);
    await Promise.all(Array.from({ length: n }, () => worker()));
    return results;
  }

  /** Read every visible foundation section's existing answers.
   *
   *  Returns:
   *    {
   *      sectionsBySection: { [sectionId]: Answer[] },
   *      structure: [{ screenId, screenLabel?, sections: [{sectionId,name}] }],
   *      errors: [{ scope: "schema"|"answers", screenId?, sectionId?, error }],
   *    }
   */
  async function listFoundationAnswers(idToken) {
    const errors = [];
    const structure = [];
    // 1) Fetch the section list for every foundation screen (concurrency 4).
    const schemaTasks = FOUNDATION_SCREEN_IDS.map(
      (screenId) => () => listScreenSections(screenId, idToken),
    );
    const schemaResults = await runWithConcurrency(schemaTasks, 4);
    const sectionIdsToFetch = [];
    schemaResults.forEach((r, i) => {
      const screenId = FOUNDATION_SCREEN_IDS[i];
      if (!r.ok) {
        errors.push({ scope: "schema", screenId, error: r.error });
        structure.push({ screenId, sections: [] });
        return;
      }
      const sections = (r.value || [])
        .filter((s) => s.hasDefaultVisibleQuestions)
        .map((s) => ({ sectionId: s.id, name: s.name }));
      structure.push({ screenId, sections });
      for (const s of sections) sectionIdsToFetch.push(s.sectionId);
    });

    // 2) Fetch each section's answers (concurrency 4).
    const answerTasks = sectionIdsToFetch.map(
      (sectionId) => () => listSectionAnswers(sectionId, idToken),
    );
    const answerResults = await runWithConcurrency(answerTasks, 4);
    const sectionsBySection = {};
    answerResults.forEach((r, i) => {
      const sectionId = sectionIdsToFetch[i];
      if (!r.ok) {
        errors.push({ scope: "answers", sectionId, error: r.error });
        sectionsBySection[sectionId] = [];
      } else {
        sectionsBySection[sectionId] = Array.isArray(r.value) ? r.value : [];
      }
    });
    return { sectionsBySection, structure, errors };
  }

  /** Read every visible per-college section's existing answers for one
   *  college. Only walks screenType ∈ {2, 3} (Questions + Writing Supplement).
   *
   *  Returns:
   *    {
   *      sectionsBySection: { [sectionId]: Answer[] },
   *      structure: [{ screenId, screenName, screenType, sections: [{sectionId,name}] }],
   *      errors: [{ scope, screenId?, sectionId?, error }],
   *    }
   */
  async function listCollegeAnswers(memberId, idToken) {
    const errors = [];
    const structure = [];
    let screens;
    try {
      screens = await listMemberScreens(memberId, idToken);
    } catch (err) {
      return {
        sectionsBySection: {},
        structure: [],
        errors: [
          {
            scope: "member-screens",
            memberId,
            error: err?.message || String(err),
          },
        ],
      };
    }
    const writableScreens = (screens || []).filter(
      (s) => s.screenType === 2 || s.screenType === 3,
    );
    // 1) Section list per screen (concurrency 4).
    const schemaTasks = writableScreens.map(
      (sc) => () => listScreenSections(sc.id, idToken),
    );
    const schemaResults = await runWithConcurrency(schemaTasks, 4);
    const sectionIdsToFetch = [];
    schemaResults.forEach((r, i) => {
      const sc = writableScreens[i];
      if (!r.ok) {
        errors.push({ scope: "schema", screenId: sc.id, error: r.error });
        structure.push({
          screenId: sc.id,
          screenName: sc.name,
          screenType: sc.screenType,
          sections: [],
        });
        return;
      }
      const sections = (r.value || [])
        .filter((s) => s.hasDefaultVisibleQuestions)
        .map((s) => ({ sectionId: s.id, name: s.name }));
      structure.push({
        screenId: sc.id,
        screenName: sc.name,
        screenType: sc.screenType,
        sections,
      });
      for (const s of sections) sectionIdsToFetch.push(s.sectionId);
    });
    // 2) Per-section answers (concurrency 4).
    const answerTasks = sectionIdsToFetch.map(
      (sectionId) => () => listSectionAnswers(sectionId, idToken),
    );
    const answerResults = await runWithConcurrency(answerTasks, 4);
    const sectionsBySection = {};
    answerResults.forEach((r, i) => {
      const sectionId = sectionIdsToFetch[i];
      if (!r.ok) {
        errors.push({ scope: "answers", sectionId, error: r.error });
        sectionsBySection[sectionId] = [];
      } else {
        sectionsBySection[sectionId] = Array.isArray(r.value) ? r.value : [];
      }
    });
    return { sectionsBySection, structure, errors };
  }

  // --- Initial session capture on page load ---

  function captureAndReportSession() {
    const session = readSessionFromLocalStorage();
    if (!session) {
      emit("agent.ca.capture", {
        success: false,
        errorCode: "ca_not_signed_in",
      });
      return;
    }
    emit("agent.ca.capture", {
      success: true,
      hasRefreshToken: !!session.refreshToken,
      hasDeviceKey: !!session.deviceKey,
      idTokenExp: jwtPayload(session.idToken)?.exp || null,
    });
    const meta = {
      username: session.username,
      hasRefreshToken: !!session.refreshToken,
      hasDeviceKey: !!session.deviceKey,
      idTokenExp: jwtPayload(session.idToken)?.exp || null,
      capturedAt: Date.now(),
    };
    // Legacy event — kept for back-compat with any existing SW handler.
    chrome.runtime.sendMessage({
      type: "CA_SESSION_CAPTURED",
      meta,
    });
    // Opportunity A — state-machine event for push-based fan-out to SPA tabs.
    emitConnectionState("connected", meta);
  }

  /**
   * Opportunity A (§8.0.11) — emit a connection-state change to the SW.
   * The SW broadcasts to subscribed SPA tabs via chrome.tabs.sendMessage.
   *
   * @param {('connected'|'disconnected'|'expired')} state
   * @param {object} [meta]
   */
  function emitConnectionState(state, meta) {
    try {
      chrome.runtime.sendMessage({
        type: "CA_CONNECTION_STATE",
        state,
        portal: "common_app",
        meta: meta || null,
      });
      emit("agent.ca.state_pushed", {
        state,
        portal: "common_app",
        latencyMsFromCapture: meta?.capturedAt
          ? Math.max(0, Date.now() - meta.capturedAt)
          : null,
      });
    } catch (e) {
      // SW disconnected — we'll re-fire on next event.
    }
  }

  // Listen for localStorage clears (sign-out from another tab) — fire
  // `disconnected`. The 'storage' event fires only for changes from
  // *other* tabs to the same origin's localStorage; sign-out via the
  // Common App UI in this tab requires the broker's onbeforeunload
  // handling instead, but covers the common multi-tab case.
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (!e || !e.key) return;
      if (
        e.key.startsWith("CognitoIdentityServiceProvider.") &&
        e.key.endsWith(".idToken") &&
        e.newValue == null
      ) {
        emitConnectionState("disconnected", { reason: "storage_cleared" });
      }
    });
    window.addEventListener("beforeunload", () => {
      // Tab closing — let SPA tabs know.
      emitConnectionState("disconnected", { reason: "tab_unloading" });
    });
  }

  // --- Message handler from service worker ---

  // Map CA_* message types → agent.ca.fill `op` property values for telemetry
  // parity with agent.fill.* events. Keeps event shape A/B-comparable.
  const FILL_OP_MAP = {
    CA_LIST_COLLEGES: "list_colleges",
    CA_ADD_COLLEGES: "add_colleges",
    CA_REMOVE_COLLEGE: "remove_college",
    CA_SAVE_ANSWERS: "save_answers",
    CA_LIST_SECTION_ANSWERS: "list_section_answers",
    CA_LIST_FOUNDATION_ANSWERS: "list_foundation_answers",
    CA_LIST_COLLEGE_ANSWERS: "list_college_answers",
    CA_PING: "ping",
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;
    if (!message.type.startsWith("CA_")) return;

    const startedAt = Date.now();
    const op = FILL_OP_MAP[message.type] || "unknown";
    // For save_answers, surface the answer count so we can correlate with /fill/plan.
    const opMeta =
      message.type === "CA_SAVE_ANSWERS"
        ? {
            answerCount: Array.isArray(message.answers)
              ? message.answers.length
              : 0,
          }
        : message.type === "CA_ADD_COLLEGES"
          ? {
              memberIdCount: Array.isArray(message.memberIds)
                ? message.memberIds.length
                : 0,
            }
          : {};

    // Phase 8 follow-up — A/B parity dimensions.
    //
    // Legacy `agent.fill.completed` carries `{ portal, section, filledCount,
    // flaggedCount }`. The Common App save_answers path now mirrors that
    // shape so dashboards can join DOM-vs-API performance per section.
    // The Accelerator's `fillExecuteService.executeGroup` threads `section`
    // and `collegeUnitid` into the CI_CA_SAVE_ANSWERS envelope; ci-bridge
    // and the service worker pass them through unchanged.
    //
    // Phase 4 #21 — `phase: "visible"|"conditional"` lets the broker mute
    // its `flaggedCount` for conditional follow-up batches: api25's
    // invalidAnswers list there means "question wasn't actually triggered
    // for this user", not a fill failure. We surface those as
    // `skippedCount` instead so the failure-rate signal stays clean.
    const abMeta =
      message.type === "CA_SAVE_ANSWERS"
        ? {
            section: message.section ?? null,
            collegeUnitid: message.collegeUnitid ?? null,
            phase: message.phase ?? "visible",
          }
        : {};

    (async () => {
      try {
        const { idToken, refreshed } = await getFreshIdToken();
        if (refreshed) {
          emit("agent.ca.refresh", { success: true });
        }
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
          case "CA_LIST_SECTION_ANSWERS":
            result = await listSectionAnswers(message.sectionId, idToken);
            break;
          case "CA_LIST_FOUNDATION_ANSWERS":
            result = await listFoundationAnswers(idToken);
            break;
          case "CA_LIST_COLLEGE_ANSWERS":
            result = await listCollegeAnswers(message.memberId, idToken);
            break;
          case "CA_PING":
            result = { connected: true, idTokenRefreshed: refreshed };
            break;
          default:
            emit("agent.ca.error", {
              code: "unknown_ca_message",
              messageType: message.type,
            });
            sendResponse({
              success: false,
              error: `unknown_ca_message:${message.type}`,
            });
            return;
        }
        // For CA_SAVE_ANSWERS: derive `filledCount` / `flaggedCount` from
        // the api25 response so dashboards can A/B-join against legacy
        // `agent.fill.completed`. Other operations omit the counts (they
        // aren't section-fills).
        //
        // Phase 4 #21: in the conditional follow-up phase, invalidAnswers
        // means "question wasn't triggered for this user" — surface those
        // as `skippedCount` instead of `flaggedCount` so dashboards don't
        // confuse them with real save failures.
        const successCounts =
          message.type === "CA_SAVE_ANSWERS"
            ? (() => {
                const validLen =
                  result?.validAnswers?.length ??
                  (Array.isArray(message.answers) ? message.answers.length : 0);
                const invalidLen = result?.invalidAnswers?.length ?? 0;
                const isConditional = message.phase === "conditional";
                return {
                  filledCount: validLen,
                  flaggedCount: isConditional ? 0 : invalidLen,
                  skippedCount: isConditional ? invalidLen : 0,
                };
              })()
            : {};
        emit("agent.ca.fill", {
          op,
          messageType: message.type,
          success: true,
          durationMs: Date.now() - startedAt,
          refreshed,
          ...opMeta,
          ...abMeta,
          ...successCounts,
        });
        sendResponse({ success: true, refreshed, result });
      } catch (err) {
        const code = String(err && err.message ? err.message : err);
        emit("agent.ca.error", { code, messageType: message.type });
        emit("agent.ca.fill", {
          op,
          messageType: message.type,
          success: false,
          errorCode: code,
          durationMs: Date.now() - startedAt,
          ...opMeta,
          ...abMeta,
        });
        // Surface refresh-specific failures as agent.ca.refresh so dashboards
        // can split refresh failures from API failures.
        if (
          code === "token_expired" ||
          code === "device_revoked" ||
          code.startsWith("cognito_refresh_failed") ||
          code === "cognito_no_id_token"
        ) {
          emit("agent.ca.refresh", { success: false, errorCode: code });
          // Opportunity A — push `expired` so SPA tabs can flip to the
          // reconnect variant of the signIn step without polling.
          emitConnectionState("expired", { errorCode: code });
        }
        sendResponse({ success: false, code, error: code });
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
