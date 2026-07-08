/**
 * api-key-extractor.js — Phase 1 #1.6
 *
 * The Common App `api25` API requires a static `X-APi-Key` header. The key is
 * baked into the Common App Angular bundle (e.g. `main.<hash>.js`) and rotates
 * occasionally — historically tied to cycle rollover (Aug 1) but possible at
 * any time. If the key rotates and we don't update the broker, path D goes
 * dark with no fallback (runtime DOM fallback is out of scope for MVP per
 * Decision #6 in APPLICATION_ACCELERATOR_DESIGN.md).
 *
 * Strategy:
 *   1. On extension startup AND on 401/403 from api25, fetch the apply.commonapp.org
 *      HTML, parse the <script src> tags, fetch the main runtime chunk, regex out
 *      the key, validate format, and persist it to chrome.storage.local with a
 *      24h TTL.
 *   2. On every broker call, read the cached key. If extraction failed, the
 *      broker fails CLOSED (does NOT silently fall back to DOM filler).
 *
 * Fixtures: CollegeInsightExtension/test/fixtures/common-app/x-api-key-bundles/
 *
 * Telemetry events:
 *   - agent.ca.apikey_extracted   { source: "startup" | "rotation_retry", keyHash }
 *   - agent.ca.apikey_rotated     { previousHash, newHash }
 *   - agent.ca.error              { code: "apikey_extraction_failed", reason }
 *
 * Loaded as a content-script lib (manifest.json content_scripts.js, before
 * common-app-broker.js). Exposes window.__ciApiKeyExtractor for the broker
 * and module.exports for unit tests.
 */

(() => {
  // Hard-coded fallback used only on first install before the extractor has
  // run once. Any successful extraction supersedes it. Never ship a build
  // without a recent extraction having succeeded in CI.
  const BAKED_IN_API_KEY = "tYFvpgKw3GaxrwoztllAc2j5bekLdMF25aayCxwx";

  const CACHE_KEY = "caApiKey";
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
  const COMMON_APP_HOST = "https://apply.commonapp.org";

  // Validation: Common App keys observed as 32-char [A-Za-z0-9]. Range 20–40
  // gives headroom for future format drift.
  const KEY_VALIDATE_RE = /^[A-Za-z0-9]{20,40}$/;

  // Match patterns for extracting the key from an Angular bundle. The
  // authenticated api25 key is the config value assigned immediately after the
  // api25 base URL, e.g.  ...api25.commonapp.org","apiKey":"<KEY>"  — this is
  // the exact key Common App's own SPA sends on every authed /answer and
  // /applicant call.
  //
  // CRITICAL (verified live 2026-07-04): do NOT match the `"X-API-Key":"..."`
  // header *literal* elsewhere in the bundle. That is a DECOY key (it sits next
  // to an `exportErrors` call); api25 REJECTS it with 403 on the authenticated
  // endpoints, so extracting it makes every write fail (0 filled, all flagged).
  // Real key `tYFvpgKw…` -> HTTP 200 validAnswers; decoy `YOxw0L2z…` -> 403.
  const EXTRACTION_PATTERNS = [
    /api25\.commonapp\.org["']\s*,\s*["']?apiKey["']?\s*:\s*["']([A-Za-z0-9]{20,40})["']/,
  ];

  /** Pure: extract the X-APi-Key from a bundle source string. */
  function extractKeyFromBundle(bundleSource) {
    if (typeof bundleSource !== "string" || bundleSource.length === 0) {
      return null;
    }
    for (const re of EXTRACTION_PATTERNS) {
      const m = bundleSource.match(re);
      if (m && KEY_VALIDATE_RE.test(m[1])) return m[1];
    }
    return null;
  }

  /**
   * Pure: parse <script src> URLs from an HTML document, returning absolute
   * URLs to JS chunks served by the Common App origin. "main"-named chunks
   * sort to the front since they are the most likely host for the constant.
   */
  function findBundleUrls(html, baseUrl) {
    if (typeof html !== "string") return [];
    const base = baseUrl || COMMON_APP_HOST;
    const urls = [];
    const scriptRe = /<script[^>]+src=["']([^"']+)["']/gi;
    let m;
    while ((m = scriptRe.exec(html)) !== null) {
      const src = m[1];
      if (!src) continue;
      let abs;
      if (src.startsWith("http://") || src.startsWith("https://")) abs = src;
      else if (src.startsWith("//")) abs = `https:${src}`;
      else if (src.startsWith("/")) abs = `${base}${src}`;
      else abs = `${base}/${src}`;
      if (/apply\.commonapp\.org/i.test(abs) || src.startsWith("/")) {
        urls.push(abs);
      }
    }
    return urls.sort((a, b) => {
      const aMain = /\bmain[.-]/i.test(a) ? 0 : 1;
      const bMain = /\bmain[.-]/i.test(b) ? 0 : 1;
      return aMain - bMain;
    });
  }

  /** Short, non-secret hash for telemetry diffs (not a security primitive). */
  function keyHash(key) {
    if (!key) return "";
    let h = 0;
    for (let i = 0; i < key.length; i++) {
      h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
  }

  /**
   * Fetch the Common App landing page, walk script srcs, fetch each candidate
   * bundle in order, return the first key that extracts + validates.
   * Throws on network failure or no-match. Same-origin from the broker tab.
   */
  async function fetchAndExtractKey(fetchImpl) {
    const f = fetchImpl || fetch;
    const htmlResp = await f(`${COMMON_APP_HOST}/`, {
      credentials: "omit",
      cache: "no-store",
    });
    if (!htmlResp.ok) throw new Error(`html_fetch_failed:${htmlResp.status}`);
    const html = await htmlResp.text();
    const urls = findBundleUrls(html);
    if (urls.length === 0) throw new Error("no_bundle_urls");

    for (const url of urls) {
      try {
        const r = await f(url, { credentials: "omit", cache: "no-store" });
        if (!r.ok) continue;
        const src = await r.text();
        const key = extractKeyFromBundle(src);
        if (key) return { key, sourceUrl: url };
      } catch {
        // try next url
      }
    }
    throw new Error("no_pattern_match");
  }

  /** Read cached key from chrome.storage.local. Null if absent or stale. */
  async function readCachedKey(storage) {
    const s =
      storage ||
      (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local);
    if (!s) return null;
    const data = await new Promise((resolve) =>
      s.get([CACHE_KEY], (d) => resolve(d || {})),
    );
    const entry = data[CACHE_KEY];
    if (!entry || !entry.key) return null;
    if (Date.now() - (entry.cachedAt || 0) > CACHE_TTL_MS) return null;
    return entry.key;
  }

  /** Persist the extracted key to chrome.storage.local. */
  async function writeCachedKey(key, storage) {
    const s =
      storage ||
      (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local);
    if (!s) return;
    await new Promise((resolve) =>
      s.set({ [CACHE_KEY]: { key, cachedAt: Date.now() } }, () => resolve()),
    );
  }

  /**
   * Resolve the current X-APi-Key:
   *   1. cached + fresh → return it
   *   2. otherwise extract → cache → return
   *   3. on extraction/validation failure → fail closed: return
   *      `{ key: null, extractionFailed: true }` and emit
   *      `agent.ca.error{code:"apikey_extraction_failed"}`. The broker MUST
   *      treat a null key as a hard stop (no Common App API call attempted)
   *      per APPLICATION_ACCELERATOR_DESIGN.md Phase 1 #1.6.
   *
   * Pass `forceRefresh: true` when the broker hits a 401/403.
   */
  async function resolveApiKey(opts) {
    const {
      forceRefresh = false,
      storage,
      fetchImpl,
      emit = () => {},
    } = opts || {};

    if (!forceRefresh) {
      const cached = await readCachedKey(storage);
      if (cached) return { key: cached, source: "cache", refreshed: false };
    }

    try {
      const { key, sourceUrl } = await fetchAndExtractKey(fetchImpl);
      const previous = await readCachedKey(storage);
      await writeCachedKey(key, storage);
      if (previous && previous !== key) {
        emit("agent.ca.apikey_rotated", {
          previousHash: keyHash(previous),
          newHash: keyHash(key),
          sourceUrl,
        });
      } else {
        emit("agent.ca.apikey_extracted", {
          source: forceRefresh ? "rotation_retry" : "startup",
          keyHash: keyHash(key),
          sourceUrl,
        });
      }
      return { key, source: "extracted", refreshed: true };
    } catch (err) {
      emit("agent.ca.error", {
        code: "apikey_extraction_failed",
        reason: String(err && err.message ? err.message : err),
      });
      // Fail closed — do NOT fall back to a stale cache or a baked-in key.
      // The broker checks `extractionFailed` and short-circuits.
      return {
        key: null,
        source: "extraction_failed",
        refreshed: false,
        extractionFailed: true,
      };
    }
  }

  const api = {
    BAKED_IN_API_KEY,
    CACHE_KEY,
    CACHE_TTL_MS,
    extractKeyFromBundle,
    findBundleUrls,
    keyHash,
    fetchAndExtractKey,
    readCachedKey,
    writeCachedKey,
    resolveApiKey,
  };

  if (typeof window !== "undefined") {
    window.__ciApiKeyExtractor = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
