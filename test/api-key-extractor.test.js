/**
 * Unit Tests: api-key-extractor.js
 *
 * Validates Phase 1 #1.6 X-APi-Key extractor against captured bundle fixtures.
 * The fixture corpus lives at test/fixtures/common-app/x-api-key-bundles/.
 * Add a new fixture there whenever a Common App bundle update breaks an
 * existing pattern; the corpus drives CI confidence that rotation is detected.
 */

const fs = require("fs");
const path = require("path");

global.window = global.window || {};

const extractor = require("../src/lib/api-key-extractor");

const FIXTURES_DIR = path.join(
  __dirname,
  "fixtures",
  "common-app",
  "x-api-key-bundles",
);

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

describe("extractKeyFromBundle", () => {
  it("extracts a quoted key from a typical bundle snippet", () => {
    const src = readFixture("2026-04-29__synthetic-quoted__tYFvpg.snippet.js");
    expect(extractor.extractKeyFromBundle(src)).toBe(
      "tYFvpgKw3GaxrwoztllAc2j5bekLdMF25aayCxwx",
    );
  });

  it("extracts a minified equals-assigned key", () => {
    const src = readFixture(
      "2026-04-29__synthetic-minified__abcdef.snippet.js",
    );
    expect(extractor.extractKeyFromBundle(src)).toBe(
      "abcdefghijklmnopqrstuvwxyz012345",
    );
  });

  it("returns null for a bundle that mentions X-APi-Key only in comments", () => {
    const src = readFixture("2026-04-29__negative-no-key.snippet.js");
    expect(extractor.extractKeyFromBundle(src)).toBeNull();
  });

  it("returns null for empty/non-string input", () => {
    expect(extractor.extractKeyFromBundle("")).toBeNull();
    expect(extractor.extractKeyFromBundle(null)).toBeNull();
    expect(extractor.extractKeyFromBundle(undefined)).toBeNull();
  });

  it("rejects keys outside the 20-40 alnum validation range", () => {
    expect(
      extractor.extractKeyFromBundle('"X-APi-Key": "tooshort"'),
    ).toBeNull();
    expect(
      extractor.extractKeyFromBundle(
        '"X-APi-Key": "way-way-too-long-and-has-dashes-not-alnum-12345"',
      ),
    ).toBeNull();
  });
});

describe("findBundleUrls", () => {
  it("returns absolute URLs and prioritizes main chunks", () => {
    const html = `
      <html><head>
        <script src="/runtime.abc.js"></script>
        <script src="/polyfills.def.js"></script>
        <script src="/main.xyz.js"></script>
      </head></html>`;
    const urls = extractor.findBundleUrls(html);
    expect(urls[0]).toBe("https://apply.commonapp.org/main.xyz.js");
    expect(urls).toHaveLength(3);
  });

  it("ignores non-script and non-Common-App URLs", () => {
    const html = `
      <script src="https://cdn.example.com/analytics.js"></script>
      <link rel="stylesheet" href="/styles.css">
      <script src="/main.xyz.js"></script>`;
    const urls = extractor.findBundleUrls(html);
    expect(urls).toEqual(["https://apply.commonapp.org/main.xyz.js"]);
  });
});

describe("resolveApiKey", () => {
  function makeStorage(initial) {
    const store = { ...(initial || {}) };
    return {
      _store: store,
      get: (keys, cb) => {
        const out = {};
        for (const k of [].concat(keys)) {
          if (k in store) out[k] = store[k];
        }
        cb(out);
      },
      set: (obj, cb) => {
        Object.assign(store, obj);
        cb();
      },
    };
  }

  function makeFetch(html, bundleSrc, opts) {
    const o = opts || {};
    return jest.fn(async (url) => {
      if (url === "https://apply.commonapp.org/") {
        return {
          ok: !o.htmlFails,
          status: o.htmlFails ? 500 : 200,
          text: async () => html,
        };
      }
      return {
        ok: !o.bundleFails,
        status: o.bundleFails ? 404 : 200,
        text: async () => bundleSrc,
      };
    });
  }

  const html = `<script src="/main.x.js"></script>`;
  const validBundle = `var H = {"X-APi-Key": "tYFvpgKw3GaxrwoztllAc2j5bekLdMF25aayCxwx"};`;

  it("returns cached key without fetching when fresh", async () => {
    const storage = makeStorage({
      caApiKey: { key: "cachedkey1234567890abcdef", cachedAt: Date.now() },
    });
    const fetchImpl = jest.fn();
    const result = await extractor.resolveApiKey({ storage, fetchImpl });
    expect(result.source).toBe("cache");
    expect(result.key).toBe("cachedkey1234567890abcdef");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("extracts and caches when no cache exists", async () => {
    const storage = makeStorage();
    const emit = jest.fn();
    const fetchImpl = makeFetch(html, validBundle);
    const result = await extractor.resolveApiKey({
      storage,
      fetchImpl,
      emit,
    });
    expect(result.source).toBe("extracted");
    expect(result.key).toBe("tYFvpgKw3GaxrwoztllAc2j5bekLdMF25aayCxwx");
    expect(storage._store.caApiKey.key).toBe(result.key);
    expect(emit).toHaveBeenCalledWith(
      "agent.ca.apikey_extracted",
      expect.objectContaining({ source: "startup" }),
    );
  });

  it("emits apikey_rotated when forced refresh yields a different key", async () => {
    const storage = makeStorage({
      caApiKey: {
        key: "oldkey1234567890abcdef0123",
        cachedAt: Date.now(),
      },
    });
    const emit = jest.fn();
    const fetchImpl = makeFetch(html, validBundle);
    await extractor.resolveApiKey({
      storage,
      fetchImpl,
      emit,
      forceRefresh: true,
    });
    expect(emit).toHaveBeenCalledWith(
      "agent.ca.apikey_rotated",
      expect.objectContaining({
        previousHash: expect.any(String),
        newHash: expect.any(String),
      }),
    );
  });

  it("fails closed (returns null key) and emits failure when extraction fails", async () => {
    const storage = makeStorage();
    const emit = jest.fn();
    const fetchImpl = makeFetch(html, "// no key in here", {});
    const result = await extractor.resolveApiKey({
      storage,
      fetchImpl,
      emit,
    });
    expect(result.extractionFailed).toBe(true);
    expect(result.key).toBeNull();
    expect(result.source).toBe("extraction_failed");
    expect(emit).toHaveBeenCalledWith(
      "agent.ca.error",
      expect.objectContaining({ code: "apikey_extraction_failed" }),
    );
  });
});
