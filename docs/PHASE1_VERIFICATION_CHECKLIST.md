# Phase 1 #1 — Packed-Extension Verification Checklist

> Manual smoke test for `docs/gen6/APPLICATION_ACCELERATOR_DESIGN.md` Phase 1 #1.
> This is the only Phase 1 task that cannot be exercised programmatically (it
> requires loading the unpacked extension into a real Chrome profile and
> exercising `chrome.tabs.sendMessage` SW → content-script hops). Run this
> once before declaring Phase 1 done; re-run after any change to
> `manifest.json`, `service-worker.js`, `ci-bridge.js`, or
> `common-app-broker.js`.

## Pre-requisites

- [ ] Chrome (or Edge) with Developer Mode enabled
- [ ] Local Frontend running on `http://localhost:7206` (`yarn start`)
- [ ] Local Backend running on `https://localhost:5001`
      (`bash scripts/dev-start-all.sh` from CollegeMatchFrontend)
- [ ] Test account credentials from `userMemory` (collegematchinfo@gmail.com / 123456)
- [ ] A working Common App account (separate test account with at least one
      college on the dashboard)

## Step 1 — Load the unpacked extension

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked** → select
   `c:\Users\suhai\workspace\CollegeInsightExtension`
4. **Expected:** "CollegeInsight Autofill" appears with no errors. The
   "Errors" button must NOT be visible. If it is, click it and capture the
   stack trace before continuing.

## Step 2 — Verify origin allowlist (Phase 1 #1.5)

For each origin below, navigate to it and open DevTools → Console. Run:

```js
window.postMessage({ type: "CI_EXTENSION_PING" }, window.location.origin);
window.addEventListener(
  "message",
  (e) => e.data?.type === "CI_EXTENSION_PONG" && console.log("PONG", e.data),
);
```

| Origin                             | Expected                                           |
| ---------------------------------- | -------------------------------------------------- |
| `http://localhost:7206`            | ✅ `CI_EXTENSION_PONG` with version received       |
| `https://localhost:5001`           | ✅ `CI_EXTENSION_PONG`                             |
| `https://www.collegeinsight.ai`    | ✅ `CI_EXTENSION_PONG` (after deploy)              |
| `https://collegeinsight.ai` (apex) | ✅ `CI_EXTENSION_PONG`                             |
| Any other origin (e.g. github.com) | ❌ no response (intentional — bridge not injected) |

## Step 3 — Verify the SW ↔ broker hop (Phase 1 #1)

This is the headline check — `chrome.tabs.sendMessage` from the SW into the
broker content script can only be tested with a live Chrome runtime.

1. Sign in to `https://apply.commonapp.org` in one tab.
2. Open `http://localhost:7206` in another tab.
3. In the localhost:7206 DevTools console:

```js
const ext = await import("/src/Features/PathToCollege/commonAppBridge.js");
await ext.isCommonAppConnected();
// Expected: true
```

4. **Expected:** `true` returned within ~1s. If `false`:
   - Open `chrome://extensions` → CollegeInsight Autofill → **Service worker**
     link → check the SW DevTools console for errors
   - Common cause: Common App tab not in MRU (most-recently-used) list;
     focus it once and retry

## Step 4 — Verify nonce gate (Phase 1 #1.7)

Without the Accelerator page, manually exercise the nonce flow:

```js
// 1. Reset bridge state
const { _resetCommonAppBridgeForTests, callCommonApp } =
  await import("/src/Features/PathToCollege/commonAppBridge.js");
_resetCommonAppBridgeForTests();

// 2. PING (auth-free) should succeed
await callCommonApp("CI_CA_PING"); // → { connected: true }

// 3. LIST_COLLEGES should mint a nonce, register it, then succeed
await callCommonApp("CI_CA_LIST_COLLEGES"); // → [memberIds...]
```

**Open the SW console** and confirm you see:

- ✅ `swTrackEvent` call for the SUCCESSFUL list (no `agent.ca.bypass_blocked`)

Then test the bypass attempt — open Common App tab DevTools and run:

```js
// Try to invoke the broker WITHOUT going through ci-bridge.js
chrome.runtime.sendMessage(
  { type: "CI_CA_LIST_COLLEGES" /* no nonce */ },
  console.log,
);
// Expected: { success: false, code: "no_nonce", error: "no_nonce" }
```

**Expected SW telemetry:** `agent.ca.bypass_blocked { code: "no_nonce" }`.

## Step 5 — Verify X-APi-Key extractor (Phase 1 #1.6)

1. Open the Common App tab DevTools → Application → Local Storage →
   `chrome-extension://...` should NOT contain `caApiKey` if you haven't
   triggered a refresh yet.
2. Run:

```js
const ext = window.__ciApiKeyExtractor;
const r = await ext.resolveApiKey({ forceRefresh: true });
console.log(r);
// Expected: { key: "...32-char-string...", source: "extracted", refreshed: true }
```

3. Check `chrome.storage.local`:

```js
chrome.storage.local.get(["caApiKey"], console.log);
// Expected: { caApiKey: { key: "...", cachedAt: <ms> } }
```

4. **Expected SW telemetry:** `agent.ca.apikey_extracted` with a `keyHash`.

## Step 6 — End-to-end smoke (the headline scenario)

The minimum "Phase 1 done" demonstration:

1. Common App tab signed in
2. localhost:7206 tab open
3. From localhost:7206 console:

```js
const { callCommonApp } =
  await import("/src/Features/PathToCollege/commonAppBridge.js");
const colleges = await callCommonApp("CI_CA_LIST_COLLEGES");
console.log("Got colleges:", colleges);
```

**Expected:** real Common App memberIds (e.g. `[71, 116, 308, 327]`)
returned, telemetry events `agent.ca.fill { op: "list", success: true }` and
optionally `agent.ca.refresh { success: true }` visible in the SW console.

If all 6 steps pass, **Phase 1 #1 is verified**. Capture screenshots of the
SW console output for the project record and update
`docs/gen6/APPLICATION_ACCELERATOR_DESIGN.md` §1 Status to remove the
"runtime integration not validated" caveat.

## Failure triage

| Symptom                                      | Likely cause                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `ca_no_tab`                                  | Common App tab not in MRU. Focus it and retry.                                              |
| `ca_response_timeout` from `commonAppBridge` | `ci-bridge.js` not injected on the current origin. Check Step 2 again.                      |
| `apikey_extraction_failed`                   | Common App bundle layout changed. Capture the new bundle in fixtures + bump regex.          |
| `no_nonce` after a successful registration   | Tab id changed (extension reload, profile switch). Re-register.                             |
| `device_revoked`                             | Common App invalidated the deviceKey. Sign out of Common App and back in.                   |
| SW console shows no events at all            | App Insights endpoint blocked by firewall — telemetry is non-blocking, ignore for the smoke |
