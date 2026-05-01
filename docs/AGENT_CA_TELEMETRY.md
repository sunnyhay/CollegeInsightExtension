# `agent.ca.*` Telemetry Event Catalog

**Owner:** CollegeInsight Extension (Common App broker, service worker, X-APi-Key extractor)
**Forwarded to:** Application Insights via service-worker `swTrackEvent` REST.
**Mirrors:** `agent.fill.*` event family — same property naming so dashboards
can A/B compare auto-fill vs. manual-fill cohorts.

> Design: [APPLICATION_ACCELERATOR_DESIGN.md](../../../CollegeMatchFrontend/docs/gen6/APPLICATION_ACCELERATOR_DESIGN.md) §11 Telemetry.

---

## Conventions

- All events are namespaced `agent.ca.<verb>`.
- Common props on every event: `success` (bool), `durationMs` (ms, for timed ops), `errorCode` (string, present iff `success:false`).
- `errorCode` values are stable strings (snake_case). Listed per event below.
- Event property values must NEVER include PII (no email, names, idTokens, refreshTokens).
- Property values that hash sensitive data use the `*Hash` suffix (e.g. `keyHash`).

---

## Events

### `agent.ca.capture`

**Where:** [`src/content/common-app-broker.js`](../src/content/common-app-broker.js) — `captureAndReportSession()`.
**When:** Once on Common App tab load, plus whenever localStorage idToken changes.
**Purpose:** Track Common App session capture rate.

| Prop              | Type      | Notes                                                    |
| ----------------- | --------- | -------------------------------------------------------- |
| `success`         | bool      |                                                          |
| `hasRefreshToken` | bool      | Only when `success:true`                                 |
| `hasDeviceKey`    | bool      | Only when `success:true`                                 |
| `idTokenExp`      | int\|null | Unix seconds, decoded from JWT. Only when `success:true` |
| `errorCode`       | string    | `ca_not_signed_in` (only on failure)                     |

---

### `agent.ca.refresh`

**Where:** `common-app-broker.js` — emitted from the message handler after `getFreshIdToken()`.
**When:** Each time the broker had to call Cognito `REFRESH_TOKEN_AUTH` (cache miss/expiry), and on every refresh failure.
**Purpose:** Detect token-rot or refresh-token revocation.

| Prop        | Type   | Notes                                                                                             |
| ----------- | ------ | ------------------------------------------------------------------------------------------------- |
| `success`   | bool   |                                                                                                   |
| `errorCode` | string | `token_expired` \| `device_revoked` \| `cognito_no_id_token` \| `cognito_refresh_failed:<status>` |

---

### `agent.ca.fill`

**Where:** `common-app-broker.js` — wraps every `CA_*` message handler.
**When:** Every Common App API call from this extension.
**Purpose:** Per-operation success rate, latency, and answer volume.

| Prop            | Type   | Notes                                                                             |
| --------------- | ------ | --------------------------------------------------------------------------------- |
| `op`            | string | `list_colleges` \| `add_colleges` \| `remove_college` \| `save_answers` \| `ping` |
| `success`       | bool   |                                                                                   |
| `durationMs`    | int    | Wall-clock for the full message handler (includes refresh)                        |
| `refreshed`     | bool   | Whether this call also refreshed the idToken                                      |
| `answerCount`   | int    | Only for `op:"save_answers"`                                                      |
| `memberIdCount` | int    | Only for `op:"add_colleges"`                                                      |
| `errorCode`     | string | See `agent.ca.error` codes (only on failure)                                      |

---

### `agent.ca.error`

**Where:** `common-app-broker.js` (broker errors) and `service-worker.js` (bridge errors).
**When:** Any structured failure surfaced by the broker or the SW bridge gate.
**Purpose:** Error taxonomy + alerting.

| Prop          | Type   | Notes                                                          |
| ------------- | ------ | -------------------------------------------------------------- |
| `code`        | string | One of the codes below                                         |
| `messageType` | string | `CA_*` message type that triggered the error (when applicable) |
| `reason`      | string | Free-form context (only `apikey_extraction_failed`)            |

**Code catalog:**

| `code`                       | Source                       | Recovery                                              |
| ---------------------------- | ---------------------------- | ----------------------------------------------------- |
| `ca_not_signed_in`           | broker `getFreshIdToken`     | Prompt user to sign in to apply.commonapp.org         |
| `token_expired`              | broker `refreshIdToken`      | Re-capture session                                    |
| `device_revoked`             | broker `refreshIdToken`      | Re-capture session (deviceKey rotation)               |
| `cognito_no_id_token`        | broker `refreshIdToken`      | Retry; alert if persistent                            |
| `cognito_refresh_failed:<n>` | broker `refreshIdToken`      | Status-code-dependent                                 |
| `apikey_rotated`             | broker `caApi` (after retry) | Trigger key re-extraction; alert if persistent        |
| `apikey_extraction_failed`   | broker `caApi` / extractor   | Hard fail; alert immediately (extractor regex broken) |
| `ca_api_error:<n>`           | broker `caApi`               | Status-code-dependent                                 |
| `unknown_ca_message`         | broker message handler       | Bug — SW sent an unexpected message type              |

---

### `agent.ca.bypass_blocked`

**Where:** [`src/background/service-worker.js`](../src/background/service-worker.js) — `CI_CA_*` handler.
**When:** A page tried to use the Common App bridge without satisfying the membership gate or nonce check.
**Purpose:** Detect attempted bypass of the premium-only gate.

| Prop          | Type   | Notes                                                                                                                                             |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`        | string | `not_premium` \| `no_nonce` \| `bad_nonce` (matches APPLICATION_ACCELERATOR_DESIGN.md Phase 1 #1.7; user-facing response uses `premium_required`) |
| `messageType` | string | The blocked `CI_CA_*` message type                                                                                                                |

---

### `agent.ca.bridge_forward`

**Where:** `service-worker.js` — `handleCommonAppBridge`.
**When:** Each time the SW forwards a `CI_CA_*` message to the apply.commonapp.org content script.
**Purpose:** Track the SW → content-script hop independently of the broker's `agent.ca.fill`. Useful for diagnosing tab-discovery / `chrome.tabs.sendMessage` failures.

| Prop          | Type   | Notes                                         |
| ------------- | ------ | --------------------------------------------- |
| `messageType` | string | The translated `CA_*` message type            |
| `tabId`       | string | Stringified id of the resolved Common App tab |

---

### `agent.ca.apikey_extracted`

**Where:** [`src/lib/api-key-extractor.js`](../src/lib/api-key-extractor.js).
**When:** Extractor successfully parsed a key from a fresh fetch.
**Purpose:** Confirm extractor is finding keys.

| Prop        | Type   | Notes                                                        |
| ----------- | ------ | ------------------------------------------------------------ |
| `source`    | string | `bundle` (always — cache-hit path doesn't emit this event)   |
| `keyHash`   | string | First 12 hex chars of SHA-256(key). Used to track rotations. |
| `sourceUrl` | string | URL of the JS bundle the key was extracted from              |

---

### `agent.ca.apikey_rotated`

**Where:** `api-key-extractor.js`.
**When:** A force-refresh extraction returned a different key than the cached one.
**Purpose:** Common App rotated their key — confirms our auto-recovery worked.

| Prop           | Type   | Notes                       |
| -------------- | ------ | --------------------------- |
| `previousHash` | string | First 12 chars of prev hash |
| `newHash`      | string | First 12 chars of new hash  |
| `sourceUrl`    | string | Bundle URL                  |

---

## Cross-event correlation

Every `CI_CA_*` request from the SPA carries a `correlationId` (generated by
the SPA, mirrored from the backend's `x-correlation-id`). The broker does NOT
forward this in `agent.ca.*` events directly today — see Phase 2 #X for adding
`correlationId` plumbing through the SW message envelope so events can be
joined with backend `/fill/plan` traces.

---

## Alerting thresholds (proposed for Phase 1 launch)

| Event/code                                        | Threshold        | Severity             |
| ------------------------------------------------- | ---------------- | -------------------- |
| `agent.ca.error{code:"apikey_extraction_failed"}` | >= 1 in 5min     | P1                   |
| `agent.ca.fill{success:false}`                    | > 10% over 30min | P2                   |
| `agent.ca.refresh{success:false}`                 | > 5% over 30min  | P2                   |
| `agent.ca.bypass_blocked`                         | > 20 in 5min     | P3 (security signal) |
| `agent.ca.apikey_rotated`                         | Any              | P4 (informational)   |
