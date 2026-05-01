/**
 * manifest.test.js — regression coverage for the MV3 manifest.
 *
 * The CI SPA → extension bridge relies on `ci-bridge.js` being injected on
 * **every** origin the SPA can be served from. If a content_scripts match
 * is missing for any of those origins, the SPA's `commonAppBridge.callCommonApp`
 * call posts a `CI_CA_*` message that nothing is listening for and times out
 * after 30s — silently breaking the entire Application Accelerator path.
 *
 * Phase 1 #1.5 (APPLICATION_ACCELERATOR_DESIGN.md): the explicit list of
 * required SPA origins is:
 *   - https://www.collegeinsight.ai/*    (prod www)
 *   - https://collegeinsight.ai/*        (prod apex)
 *   - https://collegeinsightui.azurewebsites.net/*   (Azure App Service slot)
 *   - http://localhost:7206/*            (local dev — `yarn start`)
 *   - https://localhost:5001/*           (local backend HTTPS port — used by
 *                                         the journey runner during e2e tests)
 */

const path = require("path");
const fs = require("fs");

const manifestPath = path.resolve(__dirname, "../manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const REQUIRED_SPA_ORIGINS = [
  "https://www.collegeinsight.ai/*",
  "https://collegeinsight.ai/*",
  "https://collegeinsightui.azurewebsites.net/*",
  "http://localhost:7206/*",
  "https://localhost:5001/*",
];

const PORTAL_ORIGINS = [
  "https://apply.commonapp.org/*",
  "https://api25.commonapp.org/*",
  "https://cognito-idp.us-west-2.amazonaws.com/*",
  "https://apply.universityofcalifornia.edu/*",
];

describe("manifest.json — content_scripts bridge coverage", () => {
  it("declares MV3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("injects ci-bridge.js on every SPA origin (Phase 1 #1.5)", () => {
    const bridgeBlock = manifest.content_scripts.find((cs) =>
      (cs.js || []).includes("src/content/ci-bridge.js"),
    );
    expect(bridgeBlock).toBeDefined();
    for (const origin of REQUIRED_SPA_ORIGINS) {
      expect(bridgeBlock.matches).toContain(origin);
    }
  });

  it("grants host_permissions for every SPA origin so the SW can message back", () => {
    for (const origin of REQUIRED_SPA_ORIGINS) {
      expect(manifest.host_permissions).toContain(origin);
    }
  });

  it("retains host_permissions for the Common App / UC / Cognito surfaces", () => {
    for (const origin of PORTAL_ORIGINS) {
      expect(manifest.host_permissions).toContain(origin);
    }
  });

  it("never injects ci-bridge into a portal origin (defense-in-depth)", () => {
    const bridgeBlock = manifest.content_scripts.find((cs) =>
      (cs.js || []).includes("src/content/ci-bridge.js"),
    );
    for (const origin of PORTAL_ORIGINS) {
      expect(bridgeBlock.matches).not.toContain(origin);
    }
  });
});
