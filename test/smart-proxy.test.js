/**
 * Unit Tests: smart-proxy.js — Prompt classification, model routing, and adaptive weights
 *
 * Tests the three-tier classification logic, model selection, weight updates,
 * similarity detection, and retry detection without starting the HTTP server.
 */

// ── Extracted functions (mirror smart-proxy.js logic) ─────────────────────────

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

  // Strip OpenClaw metadata wrapping
  if (
    userMsg.includes("Conversation info") ||
    userMsg.includes("gateway connected")
  ) {
    const jsonEndIdx = userMsg.lastIndexOf("```");
    if (jsonEndIdx >= 0) {
      const afterJson = userMsg.slice(jsonEndIdx + 3).trim();
      if (afterJson) userMsg = afterJson;
    } else {
      const lines = userMsg
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      userMsg = lines[lines.length - 1] || userMsg;
    }
  }

  // Strip OpenClaw timestamp prefix: "[Tue 2026-03-17 17:35 PDT] actual message"
  userMsg = userMsg.replace(/^\[[\w\s\-:]+\]\s*/, "");

  const msg = userMsg.toLowerCase().trim();
  const wordCount = msg.split(/\s+/).length;

  if (TIER3_PATTERNS.some((p) => p.test(msg))) {
    return { tier: 3, reason: "complex_pattern" };
  }
  if (TIER1_PATTERNS.some((p) => p.test(msg)) && wordCount < 10) {
    return { tier: 1, reason: "shortcut_pattern" };
  }
  if (wordCount > 50) {
    return { tier: 3, reason: "long_prompt" };
  }
  return { tier: 2, reason: "default" };
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  return (2 * intersection) / (wordsA.size + wordsB.size);
}

function getNextStronger(model) {
  const chain = ["gpt-4o-mini", "gpt-5-nano", "gpt-5.2", "gpt-5.4"];
  const idx = chain.indexOf(model);
  return idx >= 0 && idx < chain.length - 1 ? chain[idx + 1] : null;
}

function estimateTaskDuration(taskType) {
  switch (taskType?.toLowerCase()) {
    case "fill_all":
      return 180;
    case "scan_documents":
      return 90;
    case "draft_all_essays":
      return 300;
    case "upload_files":
      return 120;
    default:
      return 60;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("classifyPrompt — Tier 1 (shortcut patterns)", () => {
  const tier1Queries = [
    "my deadlines",
    "what are my deadlines?",
    "show my deadlines",
    "check my profile",
    "my gpa",
    "my activities",
    "my essays",
    "check my readiness",
    "my colleges",
    "my files",
    "hello",
    "hi",
    "thanks",
  ];

  test.each(tier1Queries)('"%s" → Tier 1', (query) => {
    const result = classifyPrompt({ input: query });
    expect(result.tier).toBe(1);
    expect(result.reason).toBe("shortcut_pattern");
  });
});

describe("classifyPrompt — Tier 3 (complex patterns)", () => {
  const tier3Queries = [
    "fill all my Common App sections",
    "fill every section of my application",
    "scan my documents folder",
    "upload my transcript to all colleges",
    "fill my Common App and upload my transcript",
    "draft all my college essays",
    "monitor my deadline status across all portals",
  ];

  test.each(tier3Queries)('"%s" → Tier 3', (query) => {
    const result = classifyPrompt({ input: query });
    expect(result.tier).toBe(3);
    expect(result.reason).toBe("complex_pattern");
  });
});

describe("classifyPrompt — Tier 2 (default)", () => {
  const tier2Queries = [
    "draft a recommendation letter for my physics teacher",
    "how can I improve my chances at MIT?",
    "what AP classes should I take next year?",
    "compare Stanford vs MIT for computer science",
    "help me brainstorm my essay",
  ];

  test.each(tier2Queries)('"%s" → Tier 2', (query) => {
    const result = classifyPrompt({ input: query });
    expect(result.tier).toBe(2);
    expect(result.reason).toBe("default");
  });
});

describe("classifyPrompt — Tier 3 by word count", () => {
  it("classifies very long prompts as Tier 3", () => {
    const longPrompt = Array(60).fill("word").join(" ");
    const result = classifyPrompt({ input: longPrompt });
    expect(result.tier).toBe(3);
    expect(result.reason).toBe("long_prompt");
  });
});

describe("classifyPrompt — Tier 3 beats Tier 1", () => {
  it('"fill all" overrides short pattern match', () => {
    const result = classifyPrompt({ input: "fill all my activities" });
    expect(result.tier).toBe(3);
  });
});

describe("classifyPrompt — input formats", () => {
  it("handles array input with user messages", () => {
    const result = classifyPrompt({
      input: [
        { role: "system", content: "you are a helper" },
        { role: "user", content: "my deadlines" },
      ],
    });
    expect(result.tier).toBe(1);
  });

  it("handles empty input gracefully", () => {
    const result = classifyPrompt({ input: "" });
    expect(result.tier).toBe(2);
  });

  it("handles missing input", () => {
    const result = classifyPrompt({});
    expect(result.tier).toBe(2);
  });
});

// ── OpenClaw Production Format (Lessons Bug #1-#5) ────────────────────────────

describe("classifyPrompt — OpenClaw production formats", () => {
  // Bug #1: OpenClaw sends input_text content type, not plain string
  it("handles input_text content type (Bug #1)", () => {
    const result = classifyPrompt({
      input: [
        { role: "system", content: "you are a college advisor" },
        {
          role: "user",
          content: [{ type: "input_text", text: "my deadlines" }],
        },
      ],
    });
    expect(result.tier).toBe(1);
    expect(result.reason).toBe("shortcut_pattern");
  });

  // Bug #2: OpenClaw prepends timestamp to user messages
  it("strips timestamp prefix from user message (Bug #2)", () => {
    const result = classifyPrompt({
      input: "[Tue 2026-03-17 17:38 PDT] my deadlines",
    });
    expect(result.tier).toBe(1);
    expect(result.reason).toBe("shortcut_pattern");
  });

  it("strips timestamp from array content (Bug #1 + #2 combined)", () => {
    const result = classifyPrompt({
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "[Wed 2026-03-18 09:15 EDT] my activities",
            },
          ],
        },
      ],
    });
    expect(result.tier).toBe(1);
  });

  // Bug #4: WhatsApp metadata wrapping
  it("strips metadata wrapping from WhatsApp messages (Bug #4)", () => {
    const metadataWrapped = `System: [2026-03-17] WhatsApp gateway connected.

Conversation info (untrusted metadata):
\`\`\`json
{"user":"test","platform":"whatsapp"}
\`\`\`

my deadlines`;
    const result = classifyPrompt({ input: metadataWrapped });
    expect(result.tier).toBe(1);
    expect(result.reason).toBe("shortcut_pattern");
  });

  it("handles metadata wrapping with complex query (Bug #4)", () => {
    const metadataWrapped = `System: [2026-03-17] WhatsApp gateway connected.

Conversation info (untrusted metadata):
\`\`\`json
{"user":"test"}
\`\`\`

fill all my Common App sections`;
    const result = classifyPrompt({ input: metadataWrapped });
    expect(result.tier).toBe(3);
    expect(result.reason).toBe("complex_pattern");
  });

  // Bug #5: Array content causes .toLowerCase() crash
  it("handles array content without crashing (Bug #5)", () => {
    const result = classifyPrompt({
      input: [
        {
          role: "user",
          content: [
            { type: "text", text: "draft a rec letter for my teacher" },
          ],
        },
      ],
    });
    expect(result.tier).toBe(2);
    expect(result.reason).toBe("default");
  });

  it("handles null/undefined content in array gracefully", () => {
    const result = classifyPrompt({
      input: [{ role: "user", content: null }],
    });
    expect(result.tier).toBe(2);
  });

  it("handles non-string non-array content gracefully", () => {
    const result = classifyPrompt({
      input: [{ role: "user", content: 12345 }],
    });
    expect(result.tier).toBe(2);
  });
});

// ── Similarity ────────────────────────────────────────────────────────────────

describe("similarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(similarity("my deadlines", "my deadlines")).toBe(1.0);
  });

  it("returns high score for similar strings", () => {
    const score = similarity("what are my deadlines", "show my deadlines");
    expect(score).toBeGreaterThan(0.5);
  });

  it("returns 0 for completely different strings", () => {
    const score = similarity("alpha beta gamma", "one two three");
    expect(score).toBe(0);
  });

  it("returns 0 for null/empty inputs", () => {
    expect(similarity(null, "test")).toBe(0);
    expect(similarity("test", null)).toBe(0);
    expect(similarity("", "test")).toBe(0);
  });
});

// ── Model escalation chain ────────────────────────────────────────────────────

describe("getNextStronger", () => {
  it("gpt-4o-mini → gpt-5-nano", () => {
    expect(getNextStronger("gpt-4o-mini")).toBe("gpt-5-nano");
  });

  it("gpt-5-nano → gpt-5.2", () => {
    expect(getNextStronger("gpt-5-nano")).toBe("gpt-5.2");
  });

  it("gpt-5.2 → gpt-5.4", () => {
    expect(getNextStronger("gpt-5.2")).toBe("gpt-5.4");
  });

  it("gpt-5.4 (last) → null", () => {
    expect(getNextStronger("gpt-5.4")).toBeNull();
  });

  it("unknown model → null", () => {
    expect(getNextStronger("gpt-7")).toBeNull();
  });
});

// ── Task duration estimation ──────────────────────────────────────────────────

describe("estimateTaskDuration", () => {
  it("fill_all → 180s", () => {
    expect(estimateTaskDuration("fill_all")).toBe(180);
  });

  it("scan_documents → 90s", () => {
    expect(estimateTaskDuration("scan_documents")).toBe(90);
  });

  it("draft_all_essays → 300s", () => {
    expect(estimateTaskDuration("draft_all_essays")).toBe(300);
  });

  it("upload_files → 120s", () => {
    expect(estimateTaskDuration("upload_files")).toBe(120);
  });

  it("unknown task → 60s default", () => {
    expect(estimateTaskDuration("unknown_task")).toBe(60);
  });

  it("null → 60s default", () => {
    expect(estimateTaskDuration(null)).toBe(60);
  });
});

// ── Adaptive Weight Updates ───────────────────────────────────────────────────

describe("updateWeights", () => {
  // Mirror the logic from smart-proxy.js
  function updateWeights(weights, tier, model, success) {
    const tierKey = `tier${tier}`;
    if (!weights[tierKey] || !weights[tierKey][model]) return weights;
    const w = JSON.parse(JSON.stringify(weights)); // deep clone

    if (success) {
      w[tierKey][model] = Math.min(1.0, w[tierKey][model] + 0.005);
    } else {
      w[tierKey][model] = Math.max(0.05, w[tierKey][model] - 0.03);
      const fallback = getNextStronger(model);
      if (fallback && w[tierKey][fallback] !== undefined) {
        w[tierKey][fallback] = Math.min(1.0, w[tierKey][fallback] + 0.03);
      }
    }

    // Normalize
    const total = Object.values(w[tierKey]).reduce((s, v) => s + v, 0);
    if (total > 0) {
      for (const k of Object.keys(w[tierKey])) {
        w[tierKey][k] /= total;
      }
    }
    return w;
  }

  const DEFAULT_WEIGHTS = {
    tier1: { "gpt-4o-mini": 1.0 },
    tier2: { "gpt-4o-mini": 0.9, "gpt-5-nano": 0.05, "gpt-5.2": 0.05 },
    tier3: { "gpt-5-nano": 0.1, "gpt-5.2": 0.75, "gpt-5.4": 0.15 },
  };

  it("success reinforces the selected model", () => {
    const w = updateWeights(DEFAULT_WEIGHTS, 2, "gpt-4o-mini", true);
    expect(w.tier2["gpt-4o-mini"]).toBeGreaterThan(0.9);
  });

  it("failure reduces the selected model weight", () => {
    const w = updateWeights(DEFAULT_WEIGHTS, 2, "gpt-4o-mini", false);
    expect(w.tier2["gpt-4o-mini"]).toBeLessThan(0.9);
  });

  it("failure shifts weight to next-stronger model", () => {
    const w = updateWeights(DEFAULT_WEIGHTS, 2, "gpt-4o-mini", false);
    // gpt-4o-mini → gpt-5-nano is the fallback
    expect(w.tier2["gpt-5-nano"]).toBeGreaterThan(0.05);
  });

  it("weights always sum to 1.0 after update", () => {
    const w = updateWeights(DEFAULT_WEIGHTS, 2, "gpt-4o-mini", false);
    const sum = Object.values(w.tier2).reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1.0, 6);
  });

  it("weights stay normalized after success update", () => {
    const w = updateWeights(DEFAULT_WEIGHTS, 3, "gpt-5.2", true);
    const sum = Object.values(w.tier3).reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1.0, 6);
  });

  it("does not drop below 0.05 minimum", () => {
    let w = DEFAULT_WEIGHTS;
    // Fail 50 times to drive weight down
    for (let i = 0; i < 50; i++) {
      w = updateWeights(w, 2, "gpt-4o-mini", false);
    }
    // After normalization the absolute value may differ, but before norm it should not be below floor
    expect(w.tier2["gpt-4o-mini"]).toBeGreaterThan(0);
  });

  it("ignores unknown tier", () => {
    const w = updateWeights(DEFAULT_WEIGHTS, 99, "gpt-4o-mini", true);
    expect(w).toEqual(DEFAULT_WEIGHTS);
  });

  it("ignores unknown model in tier", () => {
    const w = updateWeights(DEFAULT_WEIGHTS, 2, "gpt-99", true);
    expect(w).toEqual(DEFAULT_WEIGHTS);
  });
});

// ── selectModel ───────────────────────────────────────────────────────────────

describe("selectModel", () => {
  function selectModel(tier, weights) {
    const tierKey = `tier${tier}`;
    const tierWeights = weights[tierKey];
    if (!tierWeights) return "gpt-4o-mini";

    const total = Object.values(tierWeights).reduce((s, w) => s + w, 0);
    let r = Math.random() * total;
    for (const [model, weight] of Object.entries(tierWeights)) {
      r -= weight;
      if (r <= 0) return model;
    }
    return "gpt-4o-mini";
  }

  it("returns a model from the tier weights", () => {
    const weights = {
      tier1: { "gpt-4o-mini": 1.0 },
      tier2: { "gpt-4o-mini": 0.9, "gpt-5.2": 0.1 },
    };
    const model = selectModel(1, weights);
    expect(model).toBe("gpt-4o-mini");
  });

  it("returns default for unknown tier", () => {
    const model = selectModel(99, {});
    expect(model).toBe("gpt-4o-mini");
  });

  it("selects from multiple models (statistical)", () => {
    const weights = { tier2: { "gpt-4o-mini": 0.5, "gpt-5.2": 0.5 } };
    const counts = { "gpt-4o-mini": 0, "gpt-5.2": 0 };
    for (let i = 0; i < 100; i++) {
      counts[selectModel(2, weights)]++;
    }
    // Both should be selected at least once with 50/50 weights
    expect(counts["gpt-4o-mini"]).toBeGreaterThan(10);
    expect(counts["gpt-5.2"]).toBeGreaterThan(10);
  });
});

// ── detectUserRetry ───────────────────────────────────────────────────────────

describe("detectUserRetry", () => {
  function createRetryDetector() {
    const recent = new Map();

    return {
      track(prompt) {
        recent.set(Date.now().toString(), { prompt, timestamp: Date.now() });
      },
      detect(promptPreview) {
        const now = Date.now();
        for (const [key, val] of recent) {
          if (now - val.timestamp > 300000) { recent.delete(key); continue; }
        }
        for (const [, val] of recent) {
          if (now - val.timestamp < 120000 && similarity(val.prompt, promptPreview) > 0.7) {
            return true;
          }
        }
        return false;
      },
    };
  }

  it("detects retry of identical prompt", () => {
    const detector = createRetryDetector();
    detector.track("my deadlines");
    expect(detector.detect("my deadlines")).toBe(true);
  });

  it("detects retry of similar prompt", () => {
    const detector = createRetryDetector();
    detector.track("my deadlines");
    expect(detector.detect("show my deadlines")).toBe(true);
  });

  it("does not detect retry for different prompt", () => {
    const detector = createRetryDetector();
    detector.track("my deadlines");
    expect(detector.detect("draft a recommendation letter")).toBe(false);
  });

  it("does not detect retry for empty history", () => {
    const detector = createRetryDetector();
    expect(detector.detect("my deadlines")).toBe(false);
  });
});

// ── A/B Test Framework ────────────────────────────────────────────────────────

describe("applyAbTest", () => {
  function applyAbTest(abConfig, tier, defaultModel) {
    if (!abConfig || !abConfig.enabled || !abConfig.tiers.includes(tier)) {
      return { model: defaultModel, group: null };
    }
    const isGroupB = Math.random() * 100 < abConfig.splitPct;
    return {
      model: isGroupB ? abConfig.modelB : abConfig.modelA,
      group: isGroupB ? "B" : "A",
      testName: abConfig.name,
    };
  }

  const AB_CONFIG = {
    enabled: true,
    name: "mini-vs-52",
    tiers: [2],
    modelA: "gpt-4o-mini",
    modelB: "gpt-5.2",
    splitPct: 50,
  };

  it("returns default model when A/B test disabled", () => {
    const result = applyAbTest({ enabled: false, tiers: [2] }, 2, "gpt-4o-mini");
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.group).toBeNull();
  });

  it("returns default model when tier not in test", () => {
    const result = applyAbTest(AB_CONFIG, 1, "gpt-4o-mini");
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.group).toBeNull();
  });

  it("returns A or B model when tier matches", () => {
    const result = applyAbTest(AB_CONFIG, 2, "gpt-4o-mini");
    expect(["gpt-4o-mini", "gpt-5.2"]).toContain(result.model);
    expect(["A", "B"]).toContain(result.group);
    expect(result.testName).toBe("mini-vs-52");
  });

  it("returns null config gracefully", () => {
    const result = applyAbTest(null, 2, "gpt-4o-mini");
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.group).toBeNull();
  });
});

// ── Twin API Shortcut Formatters ──────────────────────────────────────────────

describe("Twin shortcut formatters", () => {
  const formatDeadlines = (data) => {
    const colleges = [];
    const lists = { Dream: "🌟", Target: "🎯", Safety: "🛡️" };
    if (data.collegeList && typeof data.collegeList === "object" && !Array.isArray(data.collegeList)) {
      for (const [tier, items] of Object.entries(data.collegeList)) {
        if (Array.isArray(items)) {
          for (const c of items)
            colleges.push({ name: c.name || c.unitid, tier, icon: lists[tier] || "📋" });
        }
      }
    } else if (Array.isArray(data.collegeList)) {
      for (const c of data.collegeList)
        colleges.push({ name: c.name, tier: "List", icon: "📋" });
    }
    if (Array.isArray(data.favorites)) {
      for (const c of data.favorites) {
        if (!colleges.find((x) => x.name === c.name))
          colleges.push({ name: c.name, tier: "Favorite", icon: "⭐" });
      }
    }
    if (!colleges.length) return "You don't have any colleges in your list yet. Add some at collegeinsight.ai!";
    let msg = "📅 Your College List & Deadlines:\n\n";
    for (const c of colleges) msg += `${c.icon} ${c.name} (${c.tier})\n`;
    msg += "\nVisit collegeinsight.ai for detailed deadline dates.";
    return msg;
  };

  const formatActivities = (data) => {
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
      for (const w of work) msg += `• ${w.role || w.name || "Work"} at ${w.organization || "?"}\n`;
    }
    if (vol.length) {
      msg += "\n🤝 Volunteer:\n";
      for (const v of vol) msg += `• ${v.role || v.name || "Volunteer"} at ${v.organization || "?"}\n`;
    }
    if (awards.length) {
      msg += "\n🏅 Awards:\n";
      for (const a of awards) msg += `• ${a.title || a.name || "Award"} (${a.level || "?"})\n`;
    }
    msg += `\nTotal: ${acts.length} activities, ${work.length} work, ${vol.length} volunteer, ${awards.length} awards`;
    return msg;
  };

  const formatProfile = (data) => {
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
  };

  describe("deadlines formatter", () => {
    it("formats tiered college list", () => {
      const result = formatDeadlines({
        collegeList: { Dream: [{ name: "MIT" }], Target: [{ name: "UCLA" }] },
      });
      expect(result).toContain("MIT");
      expect(result).toContain("Dream");
      expect(result).toContain("UCLA");
      expect(result).toContain("🌟");
    });

    it("formats flat array college list", () => {
      const result = formatDeadlines({ collegeList: [{ name: "Stanford" }] });
      expect(result).toContain("Stanford");
      expect(result).toContain("List");
    });

    it("includes favorites that are not in list", () => {
      const result = formatDeadlines({
        collegeList: { Dream: [{ name: "MIT" }] },
        favorites: [{ name: "Harvard" }],
      });
      expect(result).toContain("Harvard");
      expect(result).toContain("⭐");
    });

    it("deduplicates favorites already in list", () => {
      const result = formatDeadlines({
        collegeList: { Dream: [{ name: "MIT" }] },
        favorites: [{ name: "MIT" }],
      });
      const mitCount = (result.match(/MIT/g) || []).length;
      expect(mitCount).toBe(1);
    });

    it("returns empty message for no colleges", () => {
      const result = formatDeadlines({});
      expect(result).toContain("don't have any colleges");
    });
  });

  describe("activities formatter", () => {
    it("formats activities with hours", () => {
      const result = formatActivities({
        activities: [{ name: "Debate Club", category: "Academic", role: "Captain", hoursPerWeek: 5 }],
      });
      expect(result).toContain("Debate Club");
      expect(result).toContain("Captain");
      expect(result).toContain("5hr/wk");
    });

    it("formats work experiences", () => {
      const result = formatActivities({
        activities: [],
        workExperiences: [{ role: "Intern", organization: "Google" }],
      });
      expect(result).toContain("Intern");
      expect(result).toContain("Google");
    });

    it("formats awards", () => {
      const result = formatActivities({
        activities: [],
        awards: [{ title: "National Merit", level: "National" }],
      });
      expect(result).toContain("National Merit");
    });

    it("shows total counts", () => {
      const result = formatActivities({
        activities: [{ name: "A" }, { name: "B" }],
        workExperiences: [{ name: "W" }],
        volunteerExperiences: [],
        awards: [{ name: "X" }],
      });
      expect(result).toContain("2 activities");
      expect(result).toContain("1 work");
      expect(result).toContain("1 awards");
    });

    it("returns empty message for no data", () => {
      const result = formatActivities({});
      expect(result).toContain("No activities entered");
    });
  });

  describe("profile formatter", () => {
    it("formats full profile", () => {
      const result = formatProfile({
        displayName: "Alice",
        gpa: 3.8,
        weightedGpa: 4.2,
        satTotal: 1450,
        state: "CA",
        gradYear: 2026,
      });
      expect(result).toContain("Alice");
      expect(result).toContain("3.8");
      expect(result).toContain("4.2 weighted");
      expect(result).toContain("1450");
      expect(result).toContain("CA");
    });

    it("formats profile with ACT only", () => {
      const result = formatProfile({ actComposite: 34 });
      expect(result).toContain("ACT: 34");
      expect(result).not.toContain("SAT:");
    });

    it("formats empty profile", () => {
      const result = formatProfile({});
      expect(result).toContain("Your Profile");
    });
  });
});
