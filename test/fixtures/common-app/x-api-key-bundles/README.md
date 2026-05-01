# Common App `X-APi-Key` bundle fixtures

Captured Common App Angular bundles used by the X-APi-Key extractor unit tests
([api-key-extractor.test.js](../../api-key-extractor.test.js)) and CI
validation per design doc [Phase 1 #1.6](../../../../CollegeMatchFrontend/docs/gen6/APPLICATION_ACCELERATOR_DESIGN.md#L646).

## Why these exist

The extractor regex must keep working as Common App rotates the key and as
their Angular minifier output drifts. We pin a corpus of historical bundles
(or synthetic minimum-reproducer snippets) and run the extractor against each
on every CI build. If a new Common App release breaks all patterns, CI fails
and we know to add a new pattern before users hit it.

## Format

Each fixture is one of:

- A trimmed snippet of a real bundle (≤2KB) checked in as `.js` text. Strip
  unrelated code; keep only the section containing the `X-APi-Key` constant
  and ~50 chars of context on each side.
- A full bundle `.js.gz` (compressed) when needed for end-to-end smoke tests.

Each fixture must contain exactly one occurrence of an `X-APi-Key` constant
matching `/^[A-Za-z0-9]{20,40}$/` so the test can assert the extracted value.

## Naming

`<YYYY-MM-DD>__<source>__<hash-prefix>.snippet.js`

- `<YYYY-MM-DD>` — date the bundle was captured
- `<source>` — `prod-main`, `prod-runtime`, or a synthetic test variant name
- `<hash-prefix>` — first 6 chars of the captured key for traceability (NOT a
  secret; the keys are public and hardcoded in the bundle Common App ships)

## How to capture a new fixture

1. Open a Chrome incognito window with devtools Network tab.
2. Navigate to <https://apply.commonapp.org/>.
3. Find the `main.<hash>.js` request in Network. Open Response tab.
4. Search the response for `X-APi-Key`. Copy ~100 chars of context.
5. Save as a new file in this directory following the naming convention above.
6. Add the new file to the list in `api-key-extractor.test.js`.
7. Run `yarn test test/api-key-extractor.test.js` and confirm it still passes.

## Telemetry alert

App Insights alert fires when `agent.ca.error { code: "apikey_extraction_failed" }`
events ≥ 5/hour across users. That signals Common App changed the bundle
shape and we need a new pattern + fixture.
