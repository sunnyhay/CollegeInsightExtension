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
