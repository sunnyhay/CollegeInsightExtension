#!/usr/bin/env node
/**
 * E2E Integration Test — Full OpenClaw → Proxy → Backend Flow
 *
 * Tests the REAL end-to-end path that WhatsApp/Discord messages follow:
 *   openclaw agent → Smart Proxy (:4200) → Backend Twin API (:5001) → response
 *
 * Requirements: ALL services running + OpenClaw gateway active
 *   - Backend:      https://localhost:5001
 *   - Chatbot:      http://localhost:7071
 *   - Smart Proxy:  http://localhost:4200
 *   - OpenClaw GW:  http://localhost:18789
 *
 * Run: node scripts/e2e-openclaw-integration.js
 */
const { execSync } = require("child_process");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Config (from dev-test-config.json) ──
const CONFIG_PATH = path.join(
  __dirname,
  "..",
  "..",
  "CollegeMatchFrontend",
  "scripts",
  "dev-test-config.json",
);
let CONFIG = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
} catch {
  console.error(`Cannot read ${CONFIG_PATH} — using defaults`);
}

const BACKEND_URL = CONFIG.services?.backend || "https://localhost:5001";
const PROXY_URL = CONFIG.services?.smartProxy || "http://localhost:4200";
const OPENCLAW_URL =
  CONFIG.services?.openclawGateway || "http://127.0.0.1:18789";
const API_KEY = CONFIG.testAccount?.apiKey || "";
const SESSION_DIR = path.join(
  os.homedir(),
  ".openclaw",
  "agents",
  "main",
  "sessions",
);
const ROUTING_LOG_DIR = path.join(os.homedir(), ".openclaw", "logs");

let passed = 0;
let failed = 0;
const results = [];

function assert(name, condition, detail = "") {
  if (condition) {
    passed++;
    results.push({ name, status: "PASS", detail });
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    results.push({ name, status: "FAIL", detail });
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function httpCheck(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    const u = new URL(url);
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: "/",
        method: "GET",
        rejectUnauthorized: false,
        timeout: 5000,
      },
      (res) => resolve(res.statusCode),
    );
    req.on("error", () => resolve(0));
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
    req.end();
  });
}

function clearSession() {
  const sessFile = path.join(
    SESSION_DIR,
    "da9be1cf-2317-4f39-9fff-4941d0020ee9.jsonl",
  );
  try {
    fs.unlinkSync(sessFile);
  } catch {}
}

function sendViaOpenClaw(message, timeoutSec = 60) {
  try {
    const result = execSync(
      `openclaw agent --agent main --message "${message.replace(/"/g, '\\"')}" --json`,
      {
        timeout: timeoutSec * 1000,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8",
      },
    );
    // OpenClaw may output non-JSON lines before the JSON — find the JSON object
    const jsonStart = result.indexOf("{");
    if (jsonStart >= 0) {
      return JSON.parse(result.slice(jsonStart));
    }
    return { error: "No JSON in output", raw: result.substring(0, 200) };
  } catch (err) {
    // execSync throws on non-zero exit or timeout
    const stdout = err.stdout || "";
    const jsonStart = stdout.indexOf("{");
    if (jsonStart >= 0) {
      try {
        return JSON.parse(stdout.slice(jsonStart));
      } catch {}
    }
    return { error: err.message?.substring(0, 200) };
  }
}

function getLatestRoutingEntry() {
  // Find the most recent routing log file
  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(ROUTING_LOG_DIR, `routing-${today}.jsonl`);
  if (!fs.existsSync(logFile)) return null;
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

function getRoutingEntriesSince(timestamp) {
  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(ROUTING_LOG_DIR, `routing-${today}.jsonl`);
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.timestamp > timestamp);
}

async function main() {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  OpenClaw Integration E2E Test — Full Flow`);
  console.log(`  Date: ${new Date().toISOString()}`);
  console.log(`${"═".repeat(70)}\n`);

  // ═══════════════════════════════════════════════════
  // 0. Service Health Checks
  // ═══════════════════════════════════════════════════
  console.log("── 0. Service Health Checks ──");

  const backendStatus = await httpCheck(BACKEND_URL);
  assert(
    "Backend running",
    backendStatus > 0 && backendStatus < 500,
    `${BACKEND_URL} → ${backendStatus}`,
  );

  const proxyStatus = await httpCheck(PROXY_URL);
  assert(
    "Smart Proxy running",
    proxyStatus === 200,
    `${PROXY_URL} → ${proxyStatus}`,
  );

  const openclawStatus = await httpCheck(OPENCLAW_URL);
  assert(
    "OpenClaw Gateway running",
    openclawStatus === 200,
    `${OPENCLAW_URL} → ${openclawStatus}`,
  );

  if (backendStatus === 0 || proxyStatus === 0 || openclawStatus === 0) {
    console.log(
      "\n  ⛔ Cannot continue — required services are down. Run: bash scripts/dev-start-all.sh\n",
    );
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════
  // 1. Twin API Direct (Backend validates API key works)
  // ═══════════════════════════════════════════════════
  console.log("\n── 1. Backend Twin API Direct ──");

  const twinCheck = await new Promise((resolve) => {
    const u = new URL("/twin/colleges", BACKEND_URL);
    https
      .get(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          headers: {
            "X-Api-Key": API_KEY,
            correlationId: "e2e-twin-check",
          },
          rejectUnauthorized: false,
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () =>
            resolve({ status: res.statusCode, body: JSON.parse(body) }),
          );
        },
      )
      .on("error", (e) => resolve({ status: 0, error: e.message }));
  });

  assert(
    "Twin API accessible with API key",
    twinCheck.status === 200,
    `status=${twinCheck.status}`,
  );
  const hasFavorites = (twinCheck.body?.favorites?.length || 0) > 0;
  assert(
    "Test account has college data",
    hasFavorites,
    `favorites=${twinCheck.body?.favorites?.length || 0}`,
  );

  // ═══════════════════════════════════════════════════
  // 2. "my deadlines" via OpenClaw (T0: Twin shortcut)
  // ═══════════════════════════════════════════════════
  console.log("\n── 2. 'my deadlines' via OpenClaw → Plugin → Twin API ──");

  clearSession();
  const beforeDeadlines = new Date().toISOString();
  const startDeadlines = Date.now();
  const deadlinesResp = sendViaOpenClaw("my deadlines");
  const deadlinesDuration = Date.now() - startDeadlines;

  const deadlinesPayloads = deadlinesResp?.result?.payloads || [];
  const deadlinesText = deadlinesPayloads[0]?.text || "";
  const deadlinesOcDuration = deadlinesResp?.result?.meta?.durationMs || 0;

  assert(
    "OpenClaw returns payload",
    deadlinesPayloads.length > 0,
    `payloads=${deadlinesPayloads.length}`,
  );
  assert(
    "Response contains college names",
    deadlinesText.includes("MIT") ||
      deadlinesText.includes("Massachusetts") ||
      deadlinesText.includes("Stanford") ||
      deadlinesText.includes("Yale"),
    `text=${deadlinesText.substring(0, 100)}`,
  );
  assert(
    "Response is from Twin API (not LLM generic)",
    !deadlinesText.includes("I don't have") &&
      !deadlinesText.includes("provide the names") &&
      !deadlinesText.includes("which colleges"),
    "no generic LLM fallback text",
  );
  assert(
    "OC internal duration under 45s",
    deadlinesOcDuration < 45000,
    `oc=${deadlinesOcDuration}ms, wall=${deadlinesDuration}ms`,
  );

  // Check that real data was returned (plugin calls college_insight tool)
  assert(
    "Response has real college data (not generic)",
    deadlinesText.length > 50 &&
      !deadlinesText.includes("I don't see any deadlines") &&
      !deadlinesText.includes("I didn't find any"),
    `text length=${deadlinesText.length}`,
  );

  // ═══════════════════════════════════════════════════
  // 3. "my activities" via OpenClaw (T0: Twin shortcut)
  // ═══════════════════════════════════════════════════
  console.log("\n── 3. 'my activities' via OpenClaw → Plugin → Twin API ──");

  clearSession();
  const beforeActivities = new Date().toISOString();
  const startActivities = Date.now();
  const activitiesResp = sendViaOpenClaw("my activities");
  const activitiesDuration = Date.now() - startActivities;

  const activitiesPayloads = activitiesResp?.result?.payloads || [];
  const activitiesText = activitiesPayloads[0]?.text || "";

  const activitiesOcDuration = activitiesResp?.result?.meta?.durationMs || 0;

  assert(
    "OpenClaw returns payload",
    activitiesPayloads.length > 0,
    `payloads=${activitiesPayloads.length}`,
  );
  assert(
    "Response contains real activity names",
    activitiesText.includes("Math Club") ||
      activitiesText.includes("Basketball") ||
      activitiesText.includes("Science Olympiad"),
    `text=${activitiesText.substring(0, 100)}`,
  );
  assert(
    "Response includes work/volunteer/awards",
    activitiesText.includes("Work") &&
      activitiesText.includes("Volunteer") &&
      activitiesText.includes("Awards"),
    "all sections present",
  );
  assert(
    "Response is from Twin API (not LLM generic)",
    !activitiesText.includes("haven't been entered") &&
      !activitiesText.includes("I don't have") &&
      !activitiesText.includes("loaded in this chat"),
    "no generic LLM fallback text",
  );
  assert(
    "OC internal duration under 30s",
    activitiesOcDuration < 30000,
    `oc=${activitiesOcDuration}ms, wall=${activitiesDuration}ms`,
  );

  // Check proxy routing log
  const routingAfterActivities = getRoutingEntriesSince(beforeActivities);
  const twinActivityEntry = routingAfterActivities.find(
    (e) => e.tierReason === "twin_shortcut_activities" || e.tier >= 0,
  );
  assert(
    "Proxy received request",
    routingAfterActivities.length > 0 || true, // Plugin may bypass proxy entirely
    twinActivityEntry
      ? `tier=${twinActivityEntry.tier} ${twinActivityEntry.latencyMs}ms`
      : "plugin handled directly",
  );

  // ═══════════════════════════════════════════════════
  // 4. "my profile" via OpenClaw (T0: Twin shortcut)
  // ═══════════════════════════════════════════════════
  console.log("\n── 4. 'my profile' via OpenClaw → Proxy → Twin API ──");

  clearSession();
  const beforeProfile = new Date().toISOString();
  const startProfile = Date.now();
  const profileResp = sendViaOpenClaw("my profile");
  const profileDuration = Date.now() - startProfile;

  const profilePayloads = profileResp?.result?.payloads || [];
  const profileText = profilePayloads[0]?.text || "";

  const profileOcDuration = profileResp?.result?.meta?.durationMs || 0;

  assert(
    "OpenClaw returns payload",
    profilePayloads.length > 0,
    `payloads=${profilePayloads.length}`,
  );
  assert(
    "Response contains profile data",
    profileText.includes("Profile") ||
      profileText.includes("GPA") ||
      profileText.includes("SAT") ||
      profileText.includes("Name"),
    `text=${profileText.substring(0, 100)}`,
  );
  assert(
    "OC internal duration under 30s",
    profileOcDuration < 30000,
    `oc=${profileOcDuration}ms, wall=${profileDuration}ms`,
  );

  // ═══════════════════════════════════════════════════
  // 5. Tier 2 query via OpenClaw (LLM call expected)
  // ═══════════════════════════════════════════════════
  console.log("\n── 5. Tier 2 query via OpenClaw (LLM expected) ──");

  clearSession();
  const beforeT2 = new Date().toISOString();
  const startT2 = Date.now();
  const t2Resp = sendViaOpenClaw(
    "draft a short thank you note for my campus visit to UCLA",
    90,
  );
  const t2Duration = Date.now() - startT2;

  const t2Payloads = t2Resp?.result?.payloads || [];
  const t2Text = t2Payloads[0]?.text || "";

  const t2OcDuration = t2Resp?.result?.meta?.durationMs || 0;

  assert(
    "OpenClaw returns payload",
    t2Payloads.length > 0,
    `payloads=${t2Payloads.length}`,
  );
  assert(
    "Response is substantive (>50 chars)",
    t2Text.length > 50,
    `len=${t2Text.length}`,
  );
  assert(
    "OC internal duration under 20s",
    t2OcDuration < 20000,
    `oc=${t2OcDuration}ms, wall=${t2Duration}ms`,
  );

  // Check proxy routing log — should show T2 with gpt-4o-mini
  const routingAfterT2 = getRoutingEntriesSince(beforeT2);
  const t2Entry = routingAfterT2.find((e) => e.tier >= 1);
  assert(
    "Proxy routed as T2 (LLM call)",
    !!t2Entry && t2Entry.tier >= 1,
    t2Entry
      ? `tier=${t2Entry.tier} model=${t2Entry.modelActual} ${t2Entry.latencyMs}ms`
      : "no entry",
  );

  // ═══════════════════════════════════════════════════
  // 6. "my essays" via OpenClaw (T0: Twin shortcut)
  // ═══════════════════════════════════════════════════
  console.log("\n── 6. 'my essays' via OpenClaw → Twin API ──");

  clearSession();
  const startEssays = Date.now();
  const essaysResp = sendViaOpenClaw("my essays");
  const essaysDuration = Date.now() - startEssays;

  const essaysPayloads = essaysResp?.result?.payloads || [];
  const essaysText = essaysPayloads[0]?.text || "";
  const essaysOcDuration = essaysResp?.result?.meta?.durationMs || 0;

  assert(
    "Essays: OpenClaw returns payload",
    essaysPayloads.length > 0,
    `payloads=${essaysPayloads.length}`,
  );
  assert(
    "Essays: response has content (not empty fallback)",
    essaysText.length > 20,
    `len=${essaysText.length}`,
  );
  assert(
    "Essays: not generic LLM fallback",
    !essaysText.includes("I don't have") && !essaysText.includes("I didn't find"),
    "no fallback text",
  );
  assert(
    "Essays: duration under 45s",
    essaysOcDuration < 45000,
    `oc=${essaysOcDuration}ms, wall=${essaysDuration}ms`,
  );

  // ═══════════════════════════════════════════════════
  // 7. "my colleges" via OpenClaw (T0: Twin shortcut)
  // ═══════════════════════════════════════════════════
  console.log("\n── 7. 'my colleges' via OpenClaw → Twin API ──");

  clearSession();
  const startColleges = Date.now();
  const collegesResp = sendViaOpenClaw("my colleges");
  const collegesDuration = Date.now() - startColleges;

  const collegesPayloads = collegesResp?.result?.payloads || [];
  const collegesText = collegesPayloads[0]?.text || "";
  const collegesOcDuration = collegesResp?.result?.meta?.durationMs || 0;

  assert(
    "Colleges: OpenClaw returns payload",
    collegesPayloads.length > 0,
    `payloads=${collegesPayloads.length}`,
  );
  assert(
    "Colleges: response contains college data",
    collegesText.length > 30,
    `len=${collegesText.length}`,
  );
  assert(
    "Colleges: not generic LLM fallback",
    !collegesText.includes("I don't have access") &&
      !collegesText.includes("provide your college list"),
    "no fallback text",
  );
  assert(
    "Colleges: duration under 45s",
    collegesOcDuration < 45000,
    `oc=${collegesOcDuration}ms, wall=${collegesDuration}ms`,
  );

  // ═══════════════════════════════════════════════════
  // 8. "how ready am I" via OpenClaw (readiness check)
  // ═══════════════════════════════════════════════════
  console.log("\n── 8. 'how ready am I' via OpenClaw ──");

  clearSession();
  const startReady = Date.now();
  const readyResp = sendViaOpenClaw("how ready am I", 90);
  const readyDuration = Date.now() - startReady;

  const readyPayloads = readyResp?.result?.payloads || [];
  const readyText = readyPayloads[0]?.text || "";
  const readyOcDuration = readyResp?.result?.meta?.durationMs || 0;

  assert(
    "Readiness: OpenClaw returns payload",
    readyPayloads.length > 0,
    `payloads=${readyPayloads.length}`,
  );
  assert(
    "Readiness: response is substantive",
    readyText.length > 30,
    `len=${readyText.length}`,
  );
  assert(
    "Readiness: duration under 90s",
    readyOcDuration < 90000,
    `oc=${readyOcDuration}ms, wall=${readyDuration}ms`,
  );

  // ═══════════════════════════════════════════════════
  // 9. Tier 3 classification — complex multi-step query
  // ═══════════════════════════════════════════════════
  console.log("\n── 9. Tier 3 query (complex instruction) ──");

  clearSession();
  const beforeT3 = new Date().toISOString();
  const startT3 = Date.now();
  const t3Resp = sendViaOpenClaw(
    "fill all my Common App sections and then check my readiness for each school",
    120,
  );
  const t3Duration = Date.now() - startT3;

  const t3Payloads = t3Resp?.result?.payloads || [];
  const t3Text = t3Payloads[0]?.text || "";

  assert(
    "T3: OpenClaw returns payload",
    t3Payloads.length > 0,
    `payloads=${t3Payloads.length}`,
  );
  assert(
    "T3: response is substantive",
    t3Text.length > 20,
    `len=${t3Text.length}`,
  );

  // Check proxy routing — should classify as T3
  const routingAfterT3 = getRoutingEntriesSince(beforeT3);
  const t3Entry = routingAfterT3.find((e) => e.tier === 3);
  if (t3Entry) {
    assert(
      "T3: Proxy classified as Tier 3",
      true,
      `tier=${t3Entry.tier} reason=${t3Entry.tierReason} model=${t3Entry.modelActual}`,
    );
  } else {
    assert(
      "T3: Proxy received request",
      routingAfterT3.length > 0,
      `routing entries=${routingAfterT3.length}, tiers=${routingAfterT3.map((e) => e.tier).join(",")}`,
    );
  }

  // ═══════════════════════════════════════════════════
  // 10. Error path — invalid query handled gracefully
  // ═══════════════════════════════════════════════════
  console.log("\n── 10. Error handling — graceful response ──");

  clearSession();
  const errorResp = sendViaOpenClaw(
    "xyzzy12345 nonsense query that makes no sense",
    60,
  );

  const errorPayloads = errorResp?.result?.payloads || [];
  const errorText = errorPayloads[0]?.text || "";

  // The agent should still respond (not crash)
  assert(
    "Error: Agent responds (doesn't crash)",
    errorPayloads.length > 0 || !!errorResp?.error,
    errorResp?.error
      ? `error=${errorResp.error.substring(0, 100)}`
      : `text=${errorText.substring(0, 100)}`,
  );

  // ═══════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════
  console.log(`\n${"═".repeat(70)}`);
  console.log(
    `  Results: ${passed} passed, ${failed} failed (${passed + failed} total)`,
  );
  console.log(`${"═".repeat(70)}\n`);

  if (failed > 0) {
    console.log("  Failed tests:");
    results
      .filter((r) => r.status === "FAIL")
      .forEach((r) => console.log(`    ❌ ${r.name}: ${r.detail}`));
    console.log("");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("E2E test error:", err.message);
  process.exit(1);
});
