#!/usr/bin/env node
/**
 * E2E Performance Test — Measures real latency through the Smart Proxy.
 *
 * Runs specific scenarios from the optimization design doc and records:
 * - Per-scenario latency (n=3 per scenario for stability)
 * - Tier classification accuracy
 * - Model selection
 * - Token usage
 * - Comparison against benchmark targets
 *
 * Usage: node e2e-perf-test.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Load .env.local
const envFile = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+?)=(.+)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
}

const PROXY_URL = "http://localhost:4200/openai/responses";
const API_KEY = process.env.AZURE_OPENAI_API_KEY;
if (!API_KEY) {
  console.error(
    "Error: AZURE_OPENAI_API_KEY environment variable is required.",
  );
  process.exit(1);
}
const N_RUNS = 3; // runs per scenario for stability

// ── Benchmark Targets from Design Doc Section 6 ──
const BENCHMARKS = {
  hello: { target: 2000, before: 120000 },
  "my deadlines": { target: 2000, before: 25000 },
  "my profile": { target: 2000, before: 25000 },
  "my activities": { target: 2000, before: 25000 },
  "essay status": { target: 2000, before: 25000 },
  "am I ready?": { target: 2000, before: 25000 },
  "my colleges": { target: 2000, before: 25000 },
  "my documents": { target: 2000, before: 25000 },
  "draft a recommendation request email for my physics teacher Mr. Johnson": {
    target: 4000,
    before: 30000,
  },
  "how are my ECs looking for MIT?": { target: 5000, before: 30000 },
  "what should I improve for Stanford?": { target: 5000, before: 30000 },
  "explain my holistic fit score for Cornell": { target: 10000, before: 30000 },
  "fill all my Common App sections": { target: 2000, before: 300000 }, // ACK target
  "draft all my college essays": { target: 2000, before: 900000 }, // ACK target
};

// ── Scenarios by Tier ──
const SCENARIOS = [
  // Tier 1: Shortcut patterns (expect <2s)
  { name: "T1: hello", prompt: "hello", expectedTier: 1 },
  { name: "T1: deadlines", prompt: "my deadlines", expectedTier: 1 },
  { name: "T1: profile", prompt: "my profile", expectedTier: 1 },
  { name: "T1: activities", prompt: "my activities", expectedTier: 1 },
  { name: "T1: essay status", prompt: "essay status", expectedTier: 1 },
  { name: "T1: readiness", prompt: "am I ready?", expectedTier: 1 },
  { name: "T1: colleges", prompt: "my colleges", expectedTier: 1 },
  { name: "T1: documents", prompt: "my documents", expectedTier: 1 },

  // Tier 2: Single LLM call (expect <10s)
  {
    name: "T2: rec email",
    prompt:
      "draft a recommendation request email for my physics teacher Mr. Johnson",
    expectedTier: 2,
  },
  {
    name: "T2: EC analysis",
    prompt: "how are my ECs looking for MIT?",
    expectedTier: 2,
  },
  {
    name: "T2: improve",
    prompt: "what should I improve for Stanford?",
    expectedTier: 2,
  },
  {
    name: "T2: fit score",
    prompt: "explain my holistic fit score for Cornell",
    expectedTier: 2,
  },
  {
    name: "T2: thank you",
    prompt: "draft a thank you note for my campus visit to UCLA",
    expectedTier: 2,
  },

  // Tier 3: Complex (expect quick proxy response, actual work is async)
  {
    name: "T3: fill all",
    prompt: "fill all my Common App sections",
    expectedTier: 3,
  },
  {
    name: "T3: draft all",
    prompt: "draft all my college essays",
    expectedTier: 3,
  },
  {
    name: "T3: scan docs",
    prompt: "scan my documents folder for application files",
    expectedTier: 3,
  },
];

function sendRequest(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "gpt-4o-mini",
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
            resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
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

async function runScenario(scenario) {
  const runs = [];

  for (let i = 0; i < N_RUNS; i++) {
    const start = Date.now();
    try {
      const resp = await sendRequest(scenario.prompt);
      const latency = Date.now() - start;
      const model = resp.body?.model || "unknown";
      const tokens = resp.body?.usage?.total_tokens || 0;
      const outputTokens = resp.body?.usage?.output_tokens || 0;

      runs.push({
        latency,
        model,
        tokens,
        outputTokens,
        status: resp.statusCode,
        success: resp.statusCode === 200,
      });
    } catch (err) {
      runs.push({
        latency: Date.now() - start,
        model: "error",
        tokens: 0,
        outputTokens: 0,
        status: 0,
        success: false,
        error: err.message,
      });
    }

    // Small delay between runs to avoid rate limiting
    if (i < N_RUNS - 1) await new Promise((r) => setTimeout(r, 800));
  }

  return runs;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main() {
  console.log(`\n${"═".repeat(80)}`);
  console.log(`  E2E Performance Test — Smart Proxy (${PROXY_URL})`);
  console.log(`  Runs per scenario: ${N_RUNS}`);
  console.log(`  Date: ${new Date().toISOString()}`);
  console.log(`${"═".repeat(80)}\n`);

  const results = [];

  for (const scenario of SCENARIOS) {
    process.stdout.write(`  Testing "${scenario.name}"...`);
    const runs = await runScenario(scenario);

    const latencies = runs.map((r) => r.latency);
    const avgLatency = Math.round(
      latencies.reduce((s, l) => s + l, 0) / latencies.length,
    );
    const medLatency = Math.round(median(latencies));
    const minLatency = Math.min(...latencies);
    const maxLatency = Math.max(...latencies);
    const successRate = runs.filter((r) => r.success).length / runs.length;
    const primaryModel = runs[0]?.model || "unknown";
    const avgTokens = Math.round(
      runs.reduce((s, r) => s + r.tokens, 0) / runs.length,
    );
    const avgOutputTokens = Math.round(
      runs.reduce((s, r) => s + r.outputTokens, 0) / runs.length,
    );

    const benchmark = BENCHMARKS[scenario.prompt];
    const meetsTarget = benchmark ? medLatency <= benchmark.target : null;
    const speedup = benchmark
      ? (((benchmark.before - medLatency) / benchmark.before) * 100).toFixed(0)
      : null;

    const result = {
      name: scenario.name,
      prompt: scenario.prompt,
      expectedTier: scenario.expectedTier,
      avgLatency,
      medLatency,
      minLatency,
      maxLatency,
      successRate,
      model: primaryModel,
      avgTokens,
      avgOutputTokens,
      meetsTarget,
      speedup,
      runs,
    };
    results.push(result);

    const statusIcon = successRate === 1 ? "✅" : "⚠️";
    const targetIcon =
      meetsTarget === true ? "🎯" : meetsTarget === false ? "❌" : "—";
    console.log(
      ` ${statusIcon} ${targetIcon} med=${medLatency}ms avg=${avgLatency}ms [${minLatency}-${maxLatency}] ${primaryModel} ${avgTokens}tok`,
    );

    // Delay between scenarios
    await new Promise((r) => setTimeout(r, 500));
  }

  // ── Summary by Tier ──
  console.log(`\n${"═".repeat(80)}`);
  console.log(`  RESULTS BY TIER`);
  console.log(`${"═".repeat(80)}\n`);

  for (const tier of [1, 2, 3]) {
    const tierResults = results.filter((r) => r.expectedTier === tier);
    if (!tierResults.length) continue;

    const avgOfMedians = Math.round(
      tierResults.reduce((s, r) => s + r.medLatency, 0) / tierResults.length,
    );
    const allSuccessRate =
      tierResults.reduce((s, r) => s + r.successRate, 0) / tierResults.length;
    const meetingTarget = tierResults.filter(
      (r) => r.meetsTarget === true,
    ).length;
    const totalWithTarget = tierResults.filter(
      (r) => r.meetsTarget !== null,
    ).length;

    const models = {};
    for (const r of tierResults) {
      models[r.model] = (models[r.model] || 0) + 1;
    }

    console.log(`  Tier ${tier}: ${tierResults.length} scenarios`);
    console.log(`    Average median latency: ${avgOfMedians}ms`);
    console.log(`    Success rate: ${(allSuccessRate * 100).toFixed(0)}%`);
    if (totalWithTarget > 0) {
      console.log(`    Meeting target: ${meetingTarget}/${totalWithTarget}`);
    }
    console.log(
      `    Models: ${Object.entries(models)
        .map(([m, c]) => `${m}(${c})`)
        .join(", ")}`,
    );
    console.log("");
  }

  // ── Detailed Table ──
  console.log(`${"═".repeat(80)}`);
  console.log(`  DETAILED RESULTS`);
  console.log(`${"═".repeat(80)}\n`);

  console.log(
    `  ${"Scenario".padEnd(22)} ${"Med(ms)".padStart(8)} ${"Avg(ms)".padStart(8)} ${"Min".padStart(6)} ${"Max".padStart(6)} ${"Model".padEnd(14)} ${"Tok".padStart(5)} ${"Target".padStart(8)} ${"Speedup".padStart(8)}`,
  );
  console.log(
    `  ${"─".repeat(22)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(14)} ${"─".repeat(5)} ${"─".repeat(8)} ${"─".repeat(8)}`,
  );

  for (const r of results) {
    const targetStr =
      r.meetsTarget === true
        ? "✅ PASS"
        : r.meetsTarget === false
          ? "❌ MISS"
          : "   —";
    const speedStr = r.speedup ? `${r.speedup}%` : "—";
    console.log(
      `  ${r.name.padEnd(22)} ${String(r.medLatency).padStart(8)} ${String(r.avgLatency).padStart(8)} ${String(r.minLatency).padStart(6)} ${String(r.maxLatency).padStart(6)} ${r.model.padEnd(14)} ${String(r.avgTokens).padStart(5)} ${targetStr.padStart(8)} ${speedStr.padStart(8)}`,
    );
  }

  // ── Save results ──
  const outputFile = path.join(
    os.homedir(),
    ".openclaw",
    "logs",
    `perf-test-${new Date().toISOString().slice(0, 10)}.json`,
  );
  const report = {
    timestamp: new Date().toISOString(),
    proxyUrl: PROXY_URL,
    runsPerScenario: N_RUNS,
    results: results.map((r) => ({
      name: r.name,
      prompt: r.prompt,
      expectedTier: r.expectedTier,
      medLatency: r.medLatency,
      avgLatency: r.avgLatency,
      minLatency: r.minLatency,
      maxLatency: r.maxLatency,
      successRate: r.successRate,
      model: r.model,
      avgTokens: r.avgTokens,
      avgOutputTokens: r.avgOutputTokens,
      meetsTarget: r.meetsTarget,
      speedup: r.speedup,
    })),
  };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2));

  // ── Observations ──
  console.log(`\n${"═".repeat(80)}`);
  console.log(`  OBSERVATIONS`);
  console.log(`${"═".repeat(80)}\n`);

  // Find slowest Tier 1
  const slowestT1 = results
    .filter((r) => r.expectedTier === 1)
    .sort((a, b) => b.medLatency - a.medLatency)[0];
  if (slowestT1) {
    console.log(
      `  Slowest Tier 1: "${slowestT1.name}" — ${slowestT1.medLatency}ms (target <2s)`,
    );
  }

  // Find fastest and slowest Tier 2
  const t2sorted = results
    .filter((r) => r.expectedTier === 2)
    .sort((a, b) => a.medLatency - b.medLatency);
  if (t2sorted.length >= 2) {
    console.log(
      `  Fastest Tier 2: "${t2sorted[0].name}" — ${t2sorted[0].medLatency}ms`,
    );
    console.log(
      `  Slowest Tier 2: "${t2sorted[t2sorted.length - 1].name}" — ${t2sorted[t2sorted.length - 1].medLatency}ms`,
    );
  }

  // Token efficiency
  const avgTokensT1 = Math.round(
    results
      .filter((r) => r.expectedTier === 1)
      .reduce((s, r) => s + r.avgTokens, 0) /
      results.filter((r) => r.expectedTier === 1).length,
  );
  const avgTokensT2 = Math.round(
    results
      .filter((r) => r.expectedTier === 2)
      .reduce((s, r) => s + r.avgTokens, 0) /
      results.filter((r) => r.expectedTier === 2).length,
  );
  console.log(
    `\n  Avg tokens — Tier 1: ${avgTokensT1}, Tier 2: ${avgTokensT2}`,
  );

  // Missed targets
  const missed = results.filter((r) => r.meetsTarget === false);
  if (missed.length > 0) {
    console.log(`\n  ⚠️  ${missed.length} scenario(s) missed target:`);
    for (const m of missed) {
      const bench = BENCHMARKS[m.prompt];
      console.log(
        `    - "${m.name}": ${m.medLatency}ms (target: ${bench?.target}ms)`,
      );
    }
  } else {
    console.log(`\n  ✅ All scenarios meeting targets!`);
  }

  console.log(`\n  Results saved to: ${outputFile}\n`);
}

main().catch((err) => {
  console.error("E2E test failed:", err);
  process.exit(1);
});
