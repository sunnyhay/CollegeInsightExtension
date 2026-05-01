// Negative fixture: bundle that mentions "X-APi-Key" only in a comment or
// log-format string (no actual key constant). Extractor MUST NOT return a
// value here. Used to assert the validator rejects garbage.
function logRequest(headers) {
  console.debug("sending request with X-APi-Key header redacted");
  console.debug("expected format: X-APi-Key: <32 char alnum>");
}
