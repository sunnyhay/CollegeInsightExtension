#!/usr/bin/env bash
# ci-api — CollegeInsight API caller for OpenClaw
# Usage: ci-api <endpoint> [method]
# Example: ci-api /twin/colleges
#          ci-api /twin/activities
#          ci-api /twin/profile
#
# The API key is read from CI_API_KEY env var or the default test key.
# Base URL defaults to http://192.168.86.20:4200 (smart proxy passthrough)

set -euo pipefail

ENDPOINT="${1:?Usage: ci-api <endpoint> [method]}"
METHOD="${2:-GET}"
BASE_URL="${CI_BASE_URL:-http://192.168.86.20:4200}"
API_KEY="${CI_API_KEY:-ci_9TCnGGB6fvlQCZgnxpafKAnupM8hF2ag}"

curl -sS \
  -X "$METHOD" \
  -H "X-Api-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  "${BASE_URL}${ENDPOINT}"
