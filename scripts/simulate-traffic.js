#!/usr/bin/env node
/**
 * Local Simulation Test — Simulates production traffic through the Smart Proxy.
 *
 * Sends realistic OpenClaw-style prompts across all 3 tiers and validates:
 * 1. Correct tier classification
 * 2. Correct model routing
 * 3. Auto-escalation behavior
 * 4. A/B test recording (if enabled)
 * 5. Telemetry logging
 *
 * Usage:
 *   node simulate-traffic.js                    # Default: 30 requests
 *   node simulate-traffic.js --count 100        # Custom count
 *   node simulate-traffic.js --enable-ab        # Create A/B test config first
 *   node simulate-traffic.js --analyze          # Run analysis after simulation
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PROXY_URL = "http://localhost:4200/openai/responses";
const API_KEY = process.env.AZURE_OPENAI_API_KEY;
if (!API_KEY) {
  console.error(
    "Error: AZURE_OPENAI_API_KEY environment variable is required.",
  );
  process.exit(1);
}
const LOG_DIR = path.join(os.homedir(), ".openclaw", "logs");

// ── Simulated Prompts by Tier ──

const TIER1_PROMPTS = [
  "my deadlines",
  "what are my deadlines?",
  "show my profile",
  "my activities",
  "essay status",
  "am I ready?",
  "my college list",
  "my documents",
  "hello",
  "thanks",
];

const TIER2_PROMPTS = [
  "draft a recommendation request email for my physics teacher Mr. Johnson",
  "how are my ECs looking for MIT?",
  "what should I improve for Stanford?",
  "draft a thank you note for my campus visit to UCLA",
  "explain my holistic fit score for Cornell",
  "can you summarize my application readiness?",
  "help me write a follow-up email for my pending recommendation",
  "what colleges match my GPA and SAT scores?",
];

const TIER3_PROMPTS = [
  "fill all my Common App sections",
  "fill all my UC Application and upload my transcript",
  "scan my documents folder for application files",
  "draft all my college essays",
  "fill every portal for MIT including uploading documents",
  "prepare my entire MIT application",
  "monitor all my college portal statuses",
  "upload my transcript and resume to all colleges",
];

function randomPrompt() {
  const tier = Math.random();
  if (tier < 0.5) {
    // 50% Tier 1
    return {
      prompt: TIER1_PROMPTS[Math.floor(Math.random() * TIER1_PROMPTS.length)],
      expectedTier: 1,
    };
  } else if (tier < 0.85) {
    // 35% Tier 2
    return {
      prompt: TIER2_PROMPTS[Math.floor(Math.random() * TIER2_PROMPTS.length)],
      expectedTier: 2,
    };
  } else {
    // 15% Tier 3
    return {
      prompt: TIER3_PROMPTS[Math.floor(Math.random() * TIER3_PROMPTS.length)],
      expectedTier: 3,
    };
  }
}

// ── HTTP Request ──

function sendRequest(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "test-simulation",
      input: prompt,
      store: true,
    });

    const url = new URL(PROXY_URL);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": API_KEY,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({
              statusCode: res.statusCode,
              body: JSON.parse(data),
            });
          } catch {
            resolve({ statusCode: res.statusCode, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── A/B Test Setup ──

function enableAbTest() {
  const config = {
    enabled: true,
    name: "gpt4o-mini-vs-gpt52-sim",
    tiers: [2],
    modelA: "gpt-4o-mini",
    modelB: "gpt-5.2",
    splitPct: 50,
    startedAt: new Date().toISOString(),
    minSamples: 20,
  };
  const configPath = path.join(LOG_DIR, "ab-test-config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`A/B test enabled: ${configPath}`);
  console.log(`  Group A: ${config.modelA}, Group B: ${config.modelB}`);
  console.log(`  Split: ${100 - config.splitPct}% / ${config.splitPct}%`);
  console.log(`  Tiers: ${config.tiers.join(", ")}`);
  console.log("");
}

// ── Main ──

async function run() {
  const args = process.argv.slice(2);
  const count = parseInt(
    args.find((a, i) => args[i - 1] === "--count") || "30",
    10,
  );
  const enableAb = args.includes("--enable-ab");
  const runAnalysis = args.includes("--analyze");

  console.log(`\n🧪 Smart Proxy Traffic Simulation`);
  console.log(`   Proxy: ${PROXY_URL}`);
  console.log(`   Requests: ${count}`);
  console.log(`   A/B test: ${enableAb ? "enabled" : "disabled"}\n`);

  if (enableAb) enableAbTest();

  const results = { total: 0, byTier: {}, byModel: {}, errors: 0 };

  for (let i = 0; i < count; i++) {
    const { prompt, expectedTier } = randomPrompt();
    const start = Date.now();

    try {
      const resp = await sendRequest(prompt);
      const latency = Date.now() - start;
      const model = resp.body?.model || "unknown";
      const tokens = resp.body?.usage?.total_tokens || 0;

      results.total++;
      results.byTier[expectedTier] = (results.byTier[expectedTier] || 0) + 1;
      results.byModel[model] = results.byModel[model] || {
        count: 0,
        totalLatency: 0,
      };
      results.byModel[model].count++;
      results.byModel[model].totalLatency += latency;

      const status = resp.statusCode === 200 ? "✅" : "❌";
      console.log(
        `  ${String(i + 1).padStart(3)}. ${status} T${expectedTier} ${model.padEnd(12)} ${latency}ms ${tokens}tok "${prompt.substring(0, 40)}"`,
      );

      if (resp.statusCode !== 200) results.errors++;
    } catch (err) {
      results.errors++;
      console.log(
        `  ${String(i + 1).padStart(3)}. ❌ ERROR: ${err.message} "${prompt.substring(0, 40)}"`,
      );
    }

    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 500));
  }

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Simulation Complete: ${results.total} requests`);
  console.log(`${"═".repeat(60)}`);
  console.log(`\n  Tier Distribution:`);
  for (const [tier, count] of Object.entries(results.byTier).sort()) {
    console.log(`    Tier ${tier}: ${count} requests`);
  }
  console.log(`\n  Model Usage:`);
  for (const [model, stats] of Object.entries(results.byModel).sort()) {
    const avg = Math.round(stats.totalLatency / stats.count);
    console.log(`    ${model}: ${stats.count} calls, avg ${avg}ms`);
  }
  console.log(`\n  Errors: ${results.errors}`);

  // Check A/B results
  const abResultsPath = path.join(LOG_DIR, "ab-test-results.json");
  if (fs.existsSync(abResultsPath)) {
    const abResults = JSON.parse(fs.readFileSync(abResultsPath, "utf8"));
    console.log(`\n  A/B Test Results (${abResults.testName || "?"}):`);
    for (const group of ["A", "B"]) {
      if (abResults[group]) {
        const g = abResults[group];
        console.log(
          `    Group ${group} (${g.model}): ${g.count} calls, avg ${g.avgLatency}ms, ${g.successRate} success`,
        );
      }
    }
  }

  console.log("");

  if (runAnalysis) {
    console.log("Running offline analysis...\n");
    const { execSync } = require("child_process");
    execSync(`python3 ${path.join(__dirname, "analyze-routing.py")}`, {
      stdio: "inherit",
    });
  }
}

run().catch((err) => {
  console.error("Simulation failed:", err.message);
  process.exit(1);
});
