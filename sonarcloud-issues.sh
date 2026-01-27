#!/bin/bash

set -euo pipefail

usage() {
  cat <<'EOF'
Fetch SonarCloud issues for a branch or pull request and print the raw JSON response.

Usage:
  ./scripts/jeeves/sonarcloud-issues.sh [--branch <name> | --pull-request <id>] [--out <file>] [--host <url>]

Defaults:
  - If neither --branch nor --pull-request is provided, uses the current git branch.
  - SONAR_TOKEN is read from env or .env.sonarcloud at the repo root.
  - sonar.projectKey is read from sonar-project.properties at the repo root.
  - Host defaults to https://sonarcloud.io

Examples:
  ./scripts/jeeves/sonarcloud-issues.sh --branch issue/590-rng-prd --out jeeves/sonar-issues.json
  ./scripts/jeeves/sonarcloud-issues.sh --pull-request 1234
EOF
}

BRANCH=""
PULL_REQUEST=""
OUT_FILE=""
HOST_URL="${SONAR_HOST_URL:-https://sonarcloud.io}"

while [ $# -gt 0 ]; do
  case "$1" in
    --branch)
      BRANCH="$2"
      shift 2
      ;;
    --pull-request|--pr)
      PULL_REQUEST="$2"
      shift 2
      ;;
    --out)
      OUT_FILE="$2"
      shift 2
      ;;
    --host)
      HOST_URL="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[ERROR] Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [ -n "$BRANCH" ] && [ -n "$PULL_REQUEST" ]; then
  echo "[ERROR] Provide only one: --branch or --pull-request" >&2
  exit 1
fi

if [ -z "${SONAR_TOKEN:-}" ] && [ -f ".env.sonarcloud" ]; then
  # shellcheck disable=SC1091
  source ".env.sonarcloud"
fi

if [ -z "${SONAR_TOKEN:-}" ]; then
  echo "[ERROR] SONAR_TOKEN is required (set env or create .env.sonarcloud)" >&2
  exit 1
fi

if [ ! -f "sonar-project.properties" ]; then
  echo "[ERROR] sonar-project.properties not found at repo root" >&2
  exit 1
fi

PROJECT_KEY="$(awk -F= '/^sonar.projectKey=/{print $2}' sonar-project.properties | tail -n 1)"
if [ -z "$PROJECT_KEY" ]; then
  echo "[ERROR] Could not read sonar.projectKey from sonar-project.properties" >&2
  exit 1
fi

if [ -z "$BRANCH" ] && [ -z "$PULL_REQUEST" ]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "[ERROR] jq is required (used for URL encoding + JSON parsing)" >&2
  exit 1
fi

urlencode() {
  printf '%s' "$1" | jq -sRr @uri
}

query="componentKeys=$(urlencode "$PROJECT_KEY")&resolved=false&ps=500"
if [ -n "$BRANCH" ]; then
  query="${query}&branch=$(urlencode "$BRANCH")"
fi
if [ -n "$PULL_REQUEST" ]; then
  query="${query}&pullRequest=$(urlencode "$PULL_REQUEST")"
fi

url="${HOST_URL%/}/api/issues/search?${query}"

response="$(curl -sS -u "${SONAR_TOKEN}:" "$url")"

# Basic sanity check: ensure JSON is parseable (and avoid printing auth errors as raw text)
echo "$response" | jq . >/dev/null

if [ -n "$OUT_FILE" ]; then
  mkdir -p "$(dirname "$OUT_FILE")"
  echo "$response" > "$OUT_FILE"
fi

echo "$response"

