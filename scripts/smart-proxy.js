/**
 * Smart Routing Proxy for Azure OpenAI — CollegeInsight Agent
 *
 * Extends the simple azure-proxy.js with:
 * 1. Three-tier prompt classification (pattern matching, no LLM cost)
 * 2. Automatic model routing (gpt-4o-mini → gpt-5-nano → gpt-5.2 → gpt-5.4)
 * 3. Auto-escalation on failure (retry with stronger model within same request)
 * 4. JSONL telemetry logging for offline analysis
 * 5. Self-adaptive routing weights
 *
 * Models (from benchmark, n=10 each):
 *   gpt-4o-mini: 980ms avg, 5/5 multi-intent, 15/15 instruction following
 *   gpt-5.2:    1,493ms avg, 5/5 multi-intent, 15/15 instruction following
 *   gpt-5.4:    1,889ms avg, 5/5 multi-intent, 15/15 instruction following
 *
 * Configuration via environment variables (or .env.local):
 *   AZURE_OPENAI_ENDPOINT   — Azure OpenAI resource URL (required)
 *   AZURE_OPENAI_API_VERSION — API version (default: 2025-04-01-preview)
 *   PROXY_PORT              — Local proxy port (default: 4200)
 *   LOG_DIR                 — Log directory (default: ~/.openclaw/logs)
 *   DEFAULT_MODEL           — Default model (default: gpt-4o-mini)
 *   NANO_MODEL              — Nano reasoning model (default: gpt-5-nano)
 *   BACKUP_MODEL            — Backup model (default: gpt-5.2)
 *   REASONING_MODEL         — Heavy reasoning model (default: gpt-5.4)
 *
 * Start: node smart-proxy.js
 * Then set OpenClaw baseUrl to http://localhost:{PROXY_PORT}/openai
 */
const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Load .env.local ──
const envFile = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+?)=(.+)$/);
    if (match) {
      const key = match[1].trim();
      const val = match[2].trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

// ── Config ──
const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const API_VERSION =
  process.env.AZURE_OPENAI_API_VERSION || "2025-04-01-preview";
const PORT = parseInt(process.env.PROXY_PORT || "4200", 10);
const LOG_DIR =
  process.env.LOG_DIR || path.join(os.homedir(), ".openclaw", "logs");
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "gpt-4o-mini";
const NANO_MODEL = process.env.NANO_MODEL || "gpt-5-nano";
const BACKUP_MODEL = process.env.BACKUP_MODEL || "gpt-5.2";
const REASONING_MODEL = process.env.REASONING_MODEL || "gpt-5.4";
const APPINSIGHTS_KEY = process.env.APPINSIGHTS_INSTRUMENTATION_KEY || null;

// ── Twin API Shortcut Config ──
const CI_API_KEY = process.env.CI_API_KEY || "";
const CI_BACKEND_URL = process.env.CI_BACKEND_URL || "https://localhost:5001";

if (!AZURE_ENDPOINT) {
  console.error(
    "Error: AZURE_OPENAI_ENDPOINT environment variable is required.",
  );
  process.exit(1);
}

// Ensure log directory exists
fs.mkdirSync(LOG_DIR, { recursive: true });

// ── Prompt Classification ──

// Tier 1: ONLY match when the keyword IS the entire intent (short queries).
// Anchored to start/end to prevent greedy matches on complex sentences.
const TIER1_PATTERNS = [
  /^(what are |show |check |view )?(my )?(deadlines?|what.?s due|upcoming|when.*due)\??$/i,
  /^(what is |show |check |view )?(my )?(profile|info|gpa|sat|act)\??$/i,
  /^(what are |show |list |check )?(my )?(activit\w*|ecs?|extracurriculars?|clubs?)\??$/i,
  /^(what are |show |check )?(my )?(essays?|essay status|essay drafts?|writing)\??$/i,
  /^(check )?(my )?(readiness|how ready|am i ready|ready.{0,10}app)\??$/i,
  /^(what are |show |list |check )?(my )?(colleges?|college list|list|schools?)\??$/i,
  /^(what are |show |list |check )?(my )?(files?|documents?|scanned|transcript status)\??$/i,
  /^(hello|hi|hey|thanks|thank you|ok|okay|yo|sup)\!?\.?$/i,
];

// Tier 3: Complex multi-step (CHECKED BEFORE Tier 1 to prevent greedy matches)
const TIER3_PATTERNS = [
  /\b(fill all|fill every|fill my entire|fill.*all.*section)\b/i,
  /\bscan\b.*(folder|document|file|director)/i,
  /\b(upload.*transcript|upload.*resume|upload.*file)\b/i,
  /\b(fill.*and.*upload|fill.*and.*scan)\b/i,
  /\b(multiple.*college|all.*portal|every.*application)\b/i,
  /\b(draft all|write all|prepare all)\b/i,
  /\b(monitor.*deadline|check.*portal.*status|track.*application)\b/i,
];

function classifyPrompt(body) {
  // Extract the user message from the request body
  let userMsg = "";
  if (typeof body.input === "string") {
    userMsg = body.input;
  } else if (Array.isArray(body.input)) {
    const last = body.input.filter((m) => m.role === "user").pop();
    if (last) {
      if (typeof last.content === "string") {
        userMsg = last.content;
      } else if (Array.isArray(last.content)) {
        // OpenClaw sends content as [{type:"input_text"|"text", text:"..."}]
        const textPart = last.content.find(
          (c) => c.type === "input_text" || c.type === "text",
        );
        userMsg = textPart?.text || "";
      } else if (typeof last.text === "string") {
        userMsg = last.text;
      }
    }
  } else if (body.instructions) {
    userMsg = typeof body.input === "string" ? body.input : "";
  }

  // Ensure userMsg is always a string
  if (typeof userMsg !== "string") {
    userMsg = String(userMsg || "");
  }

  console.log(
    `[CLASSIFY] extracted userMsg (len=${userMsg.length}): "${userMsg.substring(0, 80)}"`,
  );

  // OpenClaw wraps user text in metadata like:
  // "System: [timestamp] WhatsApp gateway connected.\n\nConversation info...\n\nActual user message"
  // Extract just the actual user message (last non-empty line after metadata)
  if (
    userMsg.includes("Conversation info") ||
    userMsg.includes("gateway connected")
  ) {
    const lines = userMsg
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    // The actual message is the last line(s) after the metadata JSON block
    const jsonEndIdx = userMsg.lastIndexOf("```");
    if (jsonEndIdx >= 0) {
      const afterJson = userMsg.slice(jsonEndIdx + 3).trim();
      if (afterJson) userMsg = afterJson;
    } else {
      // Fallback: take the last non-empty line
      userMsg = lines[lines.length - 1] || userMsg;
    }
  }

  // OpenClaw prefixes user messages with timestamps: "[Tue 2026-03-17 17:35 PDT] actual message"
  userMsg = userMsg.replace(/^\[[\w\s\-:]+\]\s*/, "");

  const msg = userMsg.toLowerCase().trim();
  const wordCount = msg.split(/\s+/).length;

  // Tier 3 FIRST: Complex multi-step patterns (must beat Tier 1 greedy matches)
  if (TIER3_PATTERNS.some((p) => p.test(msg))) {
    return { tier: 3, reason: "complex_pattern" };
  }

  // Tier 1: Simple shortcut patterns (anchored — short queries only)
  if (TIER1_PATTERNS.some((p) => p.test(msg)) && wordCount < 10) {
    return { tier: 1, reason: "shortcut_pattern" };
  }

  // Tier 3: Very long prompts (likely complex instructions)
  if (wordCount > 50) {
    return { tier: 3, reason: "long_prompt" };
  }

  // Default: Tier 2 (single LLM call, moderate task)
  return { tier: 2, reason: "default" };
}

function selectModel(tier) {
  const weights = loadWeights();
  const tierKey = `tier${tier}`;
  const tierWeights = weights[tierKey];
  if (!tierWeights) return DEFAULT_MODEL;

  // Weighted random selection
  const total = Object.values(tierWeights).reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (const [model, weight] of Object.entries(tierWeights)) {
    r -= weight;
    if (r <= 0) return model;
  }
  return DEFAULT_MODEL;
}

// ── Adaptive Routing Weights ──

const WEIGHTS_FILE = path.join(LOG_DIR, "routing-weights.json");

const DEFAULT_WEIGHTS = {
  tier1: { [DEFAULT_MODEL]: 1.0 },
  tier2: { [DEFAULT_MODEL]: 0.95, [BACKUP_MODEL]: 0.05 },
  tier3: { [NANO_MODEL]: 0.1, [BACKUP_MODEL]: 0.75, [REASONING_MODEL]: 0.15 },
};

let cachedWeights = null;

function loadWeights() {
  if (cachedWeights) return cachedWeights;
  try {
    if (fs.existsSync(WEIGHTS_FILE)) {
      cachedWeights = JSON.parse(fs.readFileSync(WEIGHTS_FILE, "utf8"));
      return cachedWeights;
    }
  } catch (_) {}
  cachedWeights = { ...DEFAULT_WEIGHTS };
  return cachedWeights;
}

function saveWeights() {
  try {
    fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(cachedWeights, null, 2));
  } catch (_) {}
}

function updateWeights(tier, model, success) {
  const tierKey = `tier${tier}`;
  if (!cachedWeights[tierKey]) return;
  if (!cachedWeights[tierKey][model]) return;

  if (success) {
    // Small reinforcement — keep using what works
    cachedWeights[tierKey][model] = Math.min(
      1.0,
      cachedWeights[tierKey][model] + 0.005,
    );
  } else {
    // Shift weight toward next-stronger model
    cachedWeights[tierKey][model] = Math.max(
      0.05,
      cachedWeights[tierKey][model] - 0.03,
    );
    const fallback = getNextStronger(model);
    if (fallback && cachedWeights[tierKey][fallback] !== undefined) {
      cachedWeights[tierKey][fallback] = Math.min(
        1.0,
        cachedWeights[tierKey][fallback] + 0.03,
      );
    }
  }

  // Normalize weights so they sum to 1.0
  const total = Object.values(cachedWeights[tierKey]).reduce(
    (s, w) => s + w,
    0,
  );
  if (total > 0) {
    for (const k of Object.keys(cachedWeights[tierKey])) {
      cachedWeights[tierKey][k] /= total;
    }
  }

  // Persist every 10 updates
  if (!updateWeights._counter) updateWeights._counter = 0;
  updateWeights._counter++;
  if (updateWeights._counter % 10 === 0) saveWeights();
}

function getNextStronger(model) {
  const chain = [DEFAULT_MODEL, NANO_MODEL, BACKUP_MODEL, REASONING_MODEL];
  const idx = chain.indexOf(model);
  return idx >= 0 && idx < chain.length - 1 ? chain[idx + 1] : null;
}

// Track recent user messages for retry detection
const recentMessages = new Map(); // correlationId -> { prompt, timestamp }

function detectUserRetry(promptPreview) {
  const now = Date.now();
  // Clean old entries (>5 min)
  for (const [key, val] of recentMessages) {
    if (now - val.timestamp > 300000) recentMessages.delete(key);
  }
  // Check if similar prompt was sent in last 2 min
  for (const [, val] of recentMessages) {
    if (
      now - val.timestamp < 120000 &&
      similarity(val.prompt, promptPreview) > 0.7
    ) {
      return true;
    }
  }
  return false;
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  return (2 * intersection) / (wordsA.size + wordsB.size);
}

// ── Twin API Shortcuts (Zero-LLM path for Tier 1 data queries) ──

const TWIN_SHORTCUTS = {
  deadlines: {
    pattern:
      /^(my |check |show |what are )?(the )?(deadlines?|what.?s due|upcoming)\??$/i,
    endpoint: "/twin/colleges",
    format: (data) => {
      const colleges = [];
      const lists = { Dream: "🌟", Target: "🎯", Safety: "🛡️" };
      // Parse the college list structure
      if (
        data.collegeList &&
        typeof data.collegeList === "object" &&
        !Array.isArray(data.collegeList)
      ) {
        for (const [tier, items] of Object.entries(data.collegeList)) {
          if (Array.isArray(items)) {
            for (const c of items)
              colleges.push({
                name: c.name || c.unitid,
                tier,
                icon: lists[tier] || "📋",
              });
          }
        }
      } else if (Array.isArray(data.collegeList)) {
        for (const c of data.collegeList)
          colleges.push({ name: c.name, tier: "List", icon: "📋" });
      }
      // Also add favorites
      if (Array.isArray(data.favorites)) {
        for (const c of data.favorites) {
          if (!colleges.find((x) => x.name === c.name))
            colleges.push({ name: c.name, tier: "Favorite", icon: "⭐" });
        }
      }
      if (!colleges.length)
        return "You don't have any colleges in your list yet. Add some at collegeinsight.ai!";
      let msg = "📅 Your College List & Deadlines:\n\n";
      for (const c of colleges) msg += `${c.icon} ${c.name} (${c.tier})\n`;
      msg += "\nVisit collegeinsight.ai for detailed deadline dates.";
      return msg;
    },
  },
  activities: {
    pattern:
      /^(my |show |list |check |what are )?(the )?(activit\w*|ecs?|extracurriculars?)\??$/i,
    endpoint: "/twin/activities",
    format: (data) => {
      const acts = data.activities || [];
      const work = data.workExperiences || [];
      const vol = data.volunteerExperiences || [];
      const awards = data.awards || [];
      if (!acts.length && !work.length && !vol.length && !awards.length)
        return "No activities entered yet. Add them at collegeinsight.ai!";
      let msg = "🏆 Your Activities:\n\n";
      for (const a of acts) {
        const hrs = a.hoursPerWeek ? ` · ${a.hoursPerWeek}hr/wk` : "";
        msg += `• ${a.name || "Activity"} (${a.category || "?"}) — ${a.role || "Member"}${hrs}\n`;
      }
      if (work.length) {
        msg += "\n💼 Work:\n";
        for (const w of work)
          msg += `• ${w.role || w.name || "Work"} at ${w.organization || "?"}\n`;
      }
      if (vol.length) {
        msg += "\n🤝 Volunteer:\n";
        for (const v of vol)
          msg += `• ${v.role || v.name || "Volunteer"} at ${v.organization || "?"}\n`;
      }
      if (awards.length) {
        msg += "\n🏅 Awards:\n";
        for (const a of awards)
          msg += `• ${a.title || a.name || "Award"} (${a.level || "?"})\n`;
      }
      msg += `\nTotal: ${acts.length} activities, ${work.length} work, ${vol.length} volunteer, ${awards.length} awards`;
      return msg;
    },
  },
  profile: {
    pattern:
      /^(my |show |check |what is )?(the )?(profile|info|gpa|sat|act)\??$/i,
    endpoint: "/twin/profile",
    format: (data) => {
      let msg = "📋 Your Profile:\n\n";
      if (data.displayName) msg += `Name: ${data.displayName}\n`;
      if (data.gpa) msg += `GPA: ${data.gpa}`;
      if (data.weightedGpa) msg += ` (${data.weightedGpa} weighted)`;
      msg += "\n";
      if (data.satTotal) msg += `SAT: ${data.satTotal}\n`;
      if (data.actComposite) msg += `ACT: ${data.actComposite}\n`;
      if (data.state) msg += `State: ${data.state}\n`;
      if (data.gradYear) msg += `Grad: ${data.gradYear}\n`;
      return msg;
    },
  },
};

function callTwinApi(endpoint) {
  return new Promise((resolve, reject) => {
    if (!CI_API_KEY) return reject(new Error("CI_API_KEY not configured"));
    const url = new URL(endpoint, CI_BACKEND_URL);
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "GET",
        headers: {
          "X-Api-Key": CI_API_KEY,
          correlationId: `sp-twin-${Date.now()}`,
        },
        rejectUnauthorized: false, // localhost self-signed cert
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(
              new Error(
                `Invalid JSON from Twin API: ${body.substring(0, 100)}`,
              ),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error("Twin API timeout"));
    });
    req.end();
  });
}

function buildResponsesApiReply(text, model) {
  const now = Math.floor(Date.now() / 1000);
  const msgId = `msg_twin_${Date.now()}`;
  return JSON.stringify({
    id: `resp_twin_${Date.now()}`,
    object: "response",
    created_at: now,
    status: "completed",
    background: false,
    completed_at: now,
    error: null,
    instructions: null,
    max_output_tokens: null,
    model: model || "gpt-4o-mini",
    output: [
      {
        id: msgId,
        type: "message",
        status: "completed",
        content: [
          {
            type: "output_text",
            annotations: [],
            logprobs: [],
            text: `[[reply_to_current]] ${text}`,
          },
        ],
        role: "assistant",
      },
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: true,
    temperature: 1.0,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    truncation: "disabled",
    usage: {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    },
    metadata: {},
  });
}

async function tryTwinShortcut(userMsg, model) {
  const msg = userMsg.toLowerCase().trim();
  for (const [key, shortcut] of Object.entries(TWIN_SHORTCUTS)) {
    if (shortcut.pattern.test(msg)) {
      try {
        const data = await callTwinApi(shortcut.endpoint);
        const formatted = shortcut.format(data);
        console.log(`[TWIN] ${key} → ${shortcut.endpoint} (direct, no LLM)`);
        return {
          hit: true,
          response: buildResponsesApiReply(formatted, model),
          key,
        };
      } catch (err) {
        console.log(
          `[TWIN] ${key} API failed: ${err.message}, falling through to LLM`,
        );
        return { hit: false };
      }
    }
  }
  return { hit: false };
}

// ── A/B Test Framework ──

const AB_TEST_FILE = path.join(LOG_DIR, "ab-test-config.json");
const AB_RESULTS_FILE = path.join(LOG_DIR, "ab-test-results.json");

/*
 * A/B test config format:
 * {
 *   "enabled": true,
 *   "name": "gpt4o-mini-vs-gpt52",
 *   "tiers": [2],           // which tiers to test
 *   "modelA": "gpt-4o-mini",
 *   "modelB": "gpt-5.2",
 *   "splitPct": 50,         // % of traffic to model B
 *   "startedAt": "...",
 *   "minSamples": 50        // min per group before concluding
 * }
 */

let abTestConfig = null;

function loadAbTest() {
  try {
    if (fs.existsSync(AB_TEST_FILE)) {
      abTestConfig = JSON.parse(fs.readFileSync(AB_TEST_FILE, "utf8"));
      if (!abTestConfig.enabled) abTestConfig = null;
    }
  } catch (_) {
    abTestConfig = null;
  }
  return abTestConfig;
}

function applyAbTest(tier, defaultModel) {
  const ab = abTestConfig || loadAbTest();
  if (!ab || !ab.tiers.includes(tier))
    return { model: defaultModel, group: null };

  // Deterministic split by random
  const isGroupB = Math.random() * 100 < ab.splitPct;
  return {
    model: isGroupB ? ab.modelB : ab.modelA,
    group: isGroupB ? "B" : "A",
    testName: ab.name,
  };
}

function recordAbResult(testName, group, model, latencyMs, success) {
  if (!testName || !group) return;

  let results = {
    A: { count: 0, totalLatency: 0, successes: 0 },
    B: { count: 0, totalLatency: 0, successes: 0 },
  };
  try {
    if (fs.existsSync(AB_RESULTS_FILE)) {
      results = JSON.parse(fs.readFileSync(AB_RESULTS_FILE, "utf8"));
    }
  } catch (_) {}

  if (!results[group])
    results[group] = { count: 0, totalLatency: 0, successes: 0 };
  results[group].count++;
  results[group].totalLatency += latencyMs;
  if (success) results[group].successes++;
  results[group].model = model;
  results[group].avgLatency = Math.round(
    results[group].totalLatency / results[group].count,
  );
  results[group].successRate =
    ((results[group].successes / results[group].count) * 100).toFixed(1) + "%";
  results.testName = testName;
  results.lastUpdated = new Date().toISOString();

  fs.writeFileSync(AB_RESULTS_FILE, JSON.stringify(results, null, 2));
}

// ── Telemetry Logging ──

function logEvent(event) {
  const date = new Date().toISOString().split("T")[0];
  const logFile = path.join(LOG_DIR, `routing-${date}.jsonl`);
  const line = JSON.stringify(event) + "\n";
  fs.appendFile(logFile, line, () => {}); // async, non-blocking

  // Forward to App Insights if configured
  if (APPINSIGHTS_KEY) {
    forwardToAppInsights(event);
  }
}

function forwardToAppInsights(event) {
  const envelope = JSON.stringify({
    name: "Microsoft.ApplicationInsights.Event",
    time: event.timestamp || new Date().toISOString(),
    iKey: APPINSIGHTS_KEY,
    data: {
      baseType: "EventData",
      baseData: {
        ver: 2,
        name: "smart_proxy.routing",
        properties: {
          tier: String(event.tier || ""),
          tierReason: event.tierReason || "",
          modelSelected: event.modelSelected || "",
          modelActual: event.modelActual || "",
          escalated: String(event.escalated || false),
          escalationReason: event.escalationReason || "",
          httpStatus: String(event.httpStatus || ""),
          correlationId: event.correlationId || "",
        },
        measurements: {
          latencyMs: event.latencyMs || 0,
          responseTokens: event.responseTokens || 0,
          promptTokens: event.promptTokens || 0,
        },
      },
    },
  });

  const req = https.request(
    {
      hostname: "dc.services.visualstudio.com",
      path: "/v2/track",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
    () => {},
  );
  req.on("error", () => {}); // fire-and-forget
  req.write(envelope);
  req.end();
}

// ── Azure Request Helper ──

const REQUEST_TIMEOUT_MS = parseInt(
  process.env.REQUEST_TIMEOUT_MS || "90000",
  10,
);

function makeAzureRequest(targetUrl, method, headers, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: targetUrl.hostname,
      port: 443,
      path: targetUrl.pathname + targetUrl.search,
      method,
      headers: {
        ...headers,
        host: targetUrl.hostname,
        "content-length": Buffer.byteLength(body),
      },
      timeout: REQUEST_TIMEOUT_MS,
    };
    delete options.headers["connection"];

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.on("timeout", () => {
      req.destroy();
      reject(
        new Error(`Azure request timed out after ${REQUEST_TIMEOUT_MS}ms`),
      );
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Main Server ──

const server = http.createServer((req, res) => {
  // ── Twin API Passthrough: proxy /twin/* and /agent/* to backend over HTTPS ──
  // This allows OpenClaw's web_fetch to reach the backend via HTTP (no cert issues)
  if (
    CI_BACKEND_URL &&
    (req.url.startsWith("/twin/") || req.url.startsWith("/agent/"))
  ) {
    const backendUrl = new URL(req.url, CI_BACKEND_URL);
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const backendReq = https.request(
        {
          hostname: backendUrl.hostname,
          port: backendUrl.port || 443,
          path: backendUrl.pathname + backendUrl.search,
          method: req.method,
          headers: {
            ...req.headers,
            host: backendUrl.hostname,
            "content-length": body.length,
          },
          rejectUnauthorized: false, // localhost self-signed cert
        },
        (backendRes) => {
          res.writeHead(backendRes.statusCode, backendRes.headers);
          backendRes.pipe(res);
        },
      );
      backendReq.on("error", (err) => {
        console.error(`[TWIN-PROXY] ${req.method} ${req.url} → ${err.message}`);
        res.writeHead(502);
        res.end(
          JSON.stringify({ error: "Backend unreachable", detail: err.message }),
        );
      });
      if (body.length > 0) backendReq.write(body);
      backendReq.end();
    });
    return;
  }

  const targetUrl = new URL(req.url, AZURE_ENDPOINT);
  targetUrl.searchParams.set("api-version", API_VERSION);

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    let rawBody = Buffer.concat(chunks).toString();
    let parsed = null;

    // Parse body for Responses API POST requests
    const isResponsesApi =
      req.method === "POST" && req.url.includes("/responses");

    if (isResponsesApi) {
      try {
        parsed = JSON.parse(rawBody);
      } catch (_) {
        // Not JSON — pass through
      }
    }

    if (parsed && isResponsesApi) {
      // DEBUG: Log input array roles and last user message
      if (Array.isArray(parsed.input)) {
        const roles = parsed.input.map((m) => m.role).join(",");
        const lastUser = parsed.input.filter((m) => m.role === "user").pop();
        const lastDev = parsed.input
          .filter((m) => m.role === "developer")
          .pop();
        const lastAny = parsed.input[parsed.input.length - 1];
        console.log(
          `[DEBUG] roles=[${roles}] lastUser=${!!lastUser} lastDev=${!!lastDev} lastRole=${lastAny?.role} lastContent=${JSON.stringify(lastAny?.content)?.substring(0, 150)}`,
        );
      }
      console.log(
        `[DEBUG] keys=[${Object.keys(parsed)}] inputType=${typeof parsed.input} isArray=${Array.isArray(parsed.input)} hasPrevResp=${!!parsed.previous_response_id} input=${JSON.stringify(parsed.input)?.substring(0, 150)}`,
      );

      // Inject store: true
      if (parsed.store === undefined || parsed.store === false) {
        parsed.store = true;
      }

      // Classify and route
      const classification = classifyPrompt(parsed);
      let selectedModel = selectModel(classification.tier);
      const originalModel = parsed.model;

      const startTime = Date.now();
      const correlationId = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Extract prompt preview from user's actual text (strip OpenClaw metadata)
      let promptPreview = "";
      if (typeof parsed.input === "string") {
        promptPreview = parsed.input.substring(0, 100);
      } else if (Array.isArray(parsed.input)) {
        const lastUser = parsed.input.filter((m) => m.role === "user").pop();
        if (lastUser) {
          let raw = "";
          if (typeof lastUser.content === "string") raw = lastUser.content;
          else if (Array.isArray(lastUser.content)) {
            const tp = lastUser.content.find(
              (c) => c.type === "input_text" || c.type === "text",
            );
            raw = tp?.text || "";
          }
          // Strip OpenClaw metadata to get just the user message
          const jsonEnd = raw.lastIndexOf("```");
          if (jsonEnd >= 0) {
            promptPreview = raw
              .slice(jsonEnd + 3)
              .trim()
              .substring(0, 100);
          } else {
            promptPreview = raw.substring(0, 100);
          }
        }
      }
      // Strip OpenClaw timestamp prefix from promptPreview
      promptPreview = promptPreview.replace(/^\[[\w\s\-:]+\]\s*/, "");
      if (!promptPreview) promptPreview = "[unknown]";

      // ── Twin API Shortcut: intercept Tier 1 data queries ──
      // Disabled by default — ordinary users use web_fetch via SKILL.md.
      // Enable with ENABLE_TWIN_SHORTCUTS=true for dev acceleration.
      const enableTwinShortcuts = process.env.ENABLE_TWIN_SHORTCUTS === "true";
      if (enableTwinShortcuts && classification.tier === 1 && CI_API_KEY) {
        const twinResult = await tryTwinShortcut(
          promptPreview,
          originalModel || DEFAULT_MODEL,
        );
        if (twinResult.hit) {
          const latencyMs = Date.now() - startTime;
          logEvent({
            timestamp: new Date().toISOString(),
            correlationId,
            tier: 0, // Tier 0 = direct Twin API, no LLM
            tierReason: `twin_shortcut_${twinResult.key}`,
            modelRequested: originalModel,
            modelSelected: "twin-api",
            modelActual: "twin-api",
            promptPreview,
            promptTokens: 0,
            responseTokens: 0,
            latencyMs,
            httpStatus: 200,
            escalated: false,
            escalationReason: null,
          });
          console.log(
            `[T0] twin-api ${latencyMs}ms 200 "${promptPreview.substring(0, 40)}"`,
          );
          // If the client requested streaming, send SSE format
          if (parsed.stream) {
            const respObj = JSON.parse(twinResult.response);
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            // Send response.created event
            res.write(
              `data: ${JSON.stringify({ type: "response.created", response: { id: respObj.id, status: "in_progress", model: respObj.model, output: [] } })}\n\n`,
            );
            // Send the output item
            const outItem = respObj.output[0];
            res.write(
              `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: outItem })}\n\n`,
            );
            // Send content delta with the full text
            res.write(
              `data: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: outItem.content[0].text })}\n\n`,
            );
            // Send content done
            res.write(
              `data: ${JSON.stringify({ type: "response.output_text.done", output_index: 0, content_index: 0, text: outItem.content[0].text })}\n\n`,
            );
            // Send output_item done
            res.write(
              `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: outItem })}\n\n`,
            );
            // Send response.completed with the full response
            res.write(
              `data: ${JSON.stringify({ type: "response.completed", response: respObj })}\n\n`,
            );
            res.end();
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(twinResult.response);
          }
          return;
        }
      }

      // Retry detection: if user is re-asking similar question, escalate
      if (detectUserRetry(promptPreview)) {
        const stronger = getNextStronger(selectedModel);
        if (stronger) {
          console.log(
            `[RETRY] User retry detected, escalating ${selectedModel}→${stronger}`,
          );
          selectedModel = stronger;
        }
      }

      // A/B test: if enabled for this tier, may override selected model
      let abGroup = null;
      let abTestName = null;
      const abResult = applyAbTest(classification.tier, selectedModel);
      if (abResult.group) {
        selectedModel = abResult.model;
        abGroup = abResult.group;
        abTestName = abResult.testName;
      }

      parsed.model = selectedModel;

      const body = JSON.stringify(parsed);

      try {
        // First attempt with selected model
        let result = await makeAzureRequest(
          targetUrl,
          req.method,
          req.headers,
          body,
        );
        let latencyMs = Date.now() - startTime;
        let escalated = false;
        let escalationReason = null;
        let actualModel = selectedModel;

        // Auto-escalation chain: DEFAULT → NANO → BACKUP → REASONING
        if (result.statusCode >= 400) {
          escalated = true;
          escalationReason = `http_${result.statusCode}`;
          const chain = [
            DEFAULT_MODEL,
            NANO_MODEL,
            BACKUP_MODEL,
            REASONING_MODEL,
          ];
          const startIdx = chain.indexOf(selectedModel);
          for (let ci = startIdx + 1; ci < chain.length; ci++) {
            if (chain[ci] === selectedModel) continue;
            actualModel = chain[ci];
            parsed.model = chain[ci];
            const retryBody = JSON.stringify(parsed);
            result = await makeAzureRequest(
              targetUrl,
              req.method,
              req.headers,
              retryBody,
            );
            latencyMs = Date.now() - startTime;
            if (result.statusCode < 400) break;
          }
        }

        // Parse response for token count
        let responseTokens = 0;
        try {
          const respParsed = JSON.parse(result.body.toString());
          responseTokens = respParsed?.usage?.total_tokens || 0;
        } catch (_) {}

        // Log the event
        logEvent({
          timestamp: new Date().toISOString(),
          correlationId,
          tier: classification.tier,
          tierReason: classification.reason,
          modelRequested: originalModel,
          modelSelected: selectedModel,
          modelActual: actualModel,
          promptPreview,
          promptTokens: parsed.input?.length || 0,
          responseTokens,
          latencyMs,
          httpStatus: result.statusCode,
          escalated,
          escalationReason,
          abTestGroup: abGroup,
          abTestName: abTestName,
        });

        // Log to console for visibility
        const tierLabel = `T${classification.tier}`;
        const modelLabel = escalated
          ? `${selectedModel}→${actualModel}`
          : actualModel;
        console.log(
          `[${tierLabel}] ${modelLabel} ${latencyMs}ms ${result.statusCode} "${promptPreview.substring(0, 40)}"`,
        );

        // Update adaptive weights based on outcome
        const isSuccess = result.statusCode === 200 && !escalated;
        updateWeights(classification.tier, selectedModel, isSuccess);

        // Record A/B test result if in experiment
        if (abGroup) {
          recordAbResult(
            abTestName,
            abGroup,
            actualModel,
            latencyMs,
            isSuccess,
          );
        }

        // Track message for retry detection
        recentMessages.set(correlationId, {
          prompt: promptPreview,
          timestamp: Date.now(),
        });

        // Return response
        res.writeHead(result.statusCode, result.headers);
        res.end(result.body);
      } catch (err) {
        console.error("Proxy error:", err.message);
        logEvent({
          timestamp: new Date().toISOString(),
          correlationId,
          tier: classification.tier,
          modelSelected: selectedModel,
          error: err.message,
          latencyMs: Date.now() - startTime,
          httpStatus: 502,
        });
        res.writeHead(502);
        res.end(JSON.stringify({ error: "Proxy error", detail: err.message }));
      }
    } else {
      // Non-Responses API requests (or non-JSON) — pass through unchanged
      const body = rawBody;
      try {
        const result = await makeAzureRequest(
          targetUrl,
          req.method,
          req.headers,
          body,
        );
        res.writeHead(result.statusCode, result.headers);
        res.end(result.body);
      } catch (err) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: "Proxy error", detail: err.message }));
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n🦞 Smart Routing Proxy v1.0`);
  console.log(`   Port: http://localhost:${PORT}`);
  console.log(`   Azure: ${AZURE_ENDPOINT}`);
  console.log(`   API Version: ${API_VERSION}`);
  console.log(
    `   Models: ${DEFAULT_MODEL} → ${NANO_MODEL} → ${BACKUP_MODEL} → ${REASONING_MODEL}`,
  );
  console.log(`   Logs: ${LOG_DIR}`);
  console.log(
    `   Twin API: ${CI_API_KEY ? `✅ ${CI_BACKEND_URL} (key: ${CI_API_KEY.substring(0, 8)}...)` : "❌ not configured"}`,
  );
  console.log(`   Ready.\n`);
});

// Prevent process crash on unhandled errors
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT]", err.message);
  logEvent({
    timestamp: new Date().toISOString(),
    correlationId: "uncaught",
    tier: 0,
    error: err.message,
    httpStatus: 500,
  });
});
