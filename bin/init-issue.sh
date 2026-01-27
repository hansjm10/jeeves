#!/bin/bash

set -euo pipefail

usage() {
  cat <<'EOF'
Initialize Jeeves issue mode state.

Usage:
  ./scripts/jeeves/init-issue.sh --issue <number> [--design-doc <path>] [--repo <owner/repo>] [--branch <name>] [--state-dir <dir>] [--force]

Examples:
  ./scripts/jeeves/init-issue.sh --issue 590 --design-doc docs/rng-prd-design-issue-590.md
  ./scripts/jeeves/init-issue.sh --issue 205 --design-doc docs/runtime-event-pubsub-design.md --branch jeeves/issue-205-pubsub
  ./scripts/jeeves/init-issue.sh --issue 348 --repo owner/repo
  ./scripts/jeeves/init-issue.sh --force --issue 784 --design-doc desktop-shell-webgpu-renderer-replay-design-issue-778.md
EOF
}

STATE_DIR="jeeves"
ISSUE_NUMBER=""
DESIGN_DOC_PATH=""
REPO=""
BRANCH_NAME=""
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --state-dir)
      STATE_DIR="$2"
      shift 2
      ;;
    --issue)
      ISSUE_NUMBER="$2"
      shift 2
      ;;
    --design-doc)
      DESIGN_DOC_PATH="$2"
      shift 2
      ;;
    --repo)
      REPO="$2"
      shift 2
      ;;
    --branch)
      BRANCH_NAME="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift 1
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

if [ -z "$ISSUE_NUMBER" ]; then
  echo "[ERROR] Required: --issue" >&2
  usage
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "[ERROR] jq is required (used to write JSON safely)" >&2
  exit 1
fi

ISSUE_NUMBER="${ISSUE_NUMBER#\#}"
if [[ "$ISSUE_NUMBER" =~ ^https?:// ]]; then
  ISSUE_NUMBER="$(printf '%s' "$ISSUE_NUMBER" | sed -E 's|.*/issues/([0-9]+).*|\\1|')"
fi
if ! [[ "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "[ERROR] --issue must be a number (or URL), got: $ISSUE_NUMBER" >&2
  exit 1
fi

if [ -z "$DESIGN_DOC_PATH" ]; then
  DESIGN_DOC_PATH="docs/issue-${ISSUE_NUMBER}-design.md"
elif [ ! -f "$DESIGN_DOC_PATH" ]; then
  candidate="docs/$DESIGN_DOC_PATH"
  if [ -f "$candidate" ]; then
    DESIGN_DOC_PATH="$candidate"
  elif [[ "$DESIGN_DOC_PATH" != docs/* ]] && [[ "$DESIGN_DOC_PATH" != */* ]]; then
    DESIGN_DOC_PATH="docs/$DESIGN_DOC_PATH"
  fi
fi

if [ -z "$BRANCH_NAME" ]; then
  base="$(basename "$DESIGN_DOC_PATH")"
  base="${base%.*}"
  slug="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  slug="${slug#issue-${ISSUE_NUMBER}-}"
  slug="${slug#${ISSUE_NUMBER}-}"
  if [ -n "$slug" ]; then
    BRANCH_NAME="issue/${ISSUE_NUMBER}-${slug}"
  else
    BRANCH_NAME="issue/${ISSUE_NUMBER}"
  fi
fi

mkdir -p "$STATE_DIR"

ISSUE_FILE="$STATE_DIR/issue.json"
if [ -f "$ISSUE_FILE" ]; then
  if [ "$FORCE" = "1" ]; then
    echo "[WARN] Overwriting existing $ISSUE_FILE (--force)." >&2
  else
    if [ -s "$ISSUE_FILE" ]; then
      echo "[ERROR] $ISSUE_FILE already exists" >&2
      echo "[ERROR] Re-run with --force to overwrite." >&2
      exit 1
    fi
    echo "[WARN] $ISSUE_FILE exists but is empty; overwriting." >&2
  fi
fi

TMP_FILE="$(mktemp "$STATE_DIR/issue.json.tmp.XXXXXX")"
cleanup() {
  rm -f "$TMP_FILE"
}
trap cleanup EXIT

jq -n \
  --arg project "$(basename "$(pwd)")" \
  --arg branchName "$BRANCH_NAME" \
  --argjson issueNumber "$ISSUE_NUMBER" \
  --arg repo "$REPO" \
  --arg designDocPath "$DESIGN_DOC_PATH" \
  '{
    project: $project,
    branchName: $branchName,
    issue: ({ number: $issueNumber } + (if $repo == "" then {} else { repo: $repo } end)),
    designDocPath: $designDocPath,
    status: {
      implemented: false,
      prCreated: false,
      prDescriptionReady: false,
      reviewClean: false,
      reviewPasses: 0,
      reviewCleanPasses: 0,
      ciClean: false,
      ciPasses: 0,
      coverageClean: false,
      coverageNeedsFix: false,
      coveragePasses: 0,
      sonarClean: false
    },
    notes: ""
  }' > "$TMP_FILE"

mv "$TMP_FILE" "$ISSUE_FILE"
trap - EXIT

echo "[INFO] Wrote $ISSUE_FILE"
echo "[INFO] Branch: $BRANCH_NAME"
echo "[INFO] Design doc: $DESIGN_DOC_PATH"
if [ -n "$REPO" ]; then
  echo "[INFO] Repo: $REPO"
fi
