// Synthetic fixture mirroring the observed shape of the X-APi-Key constant
// in the production Common App Angular bundle. Trimmed to the smallest
// reproducer that still exercises the extractor's primary regex.
// See README.md in this directory for capture procedure.
const ApiClientConfig = {
  baseUrl: "https://api25.commonapp.org",
  headers: {
    "X-APi-Key": "tYFvpgKw3GaxrwoztllAc2j5bekLdMF25aayCxwx",
    Accept: "application/json",
  },
  timeoutMs: 30000,
};
