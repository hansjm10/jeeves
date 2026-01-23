#!/bin/bash

set -euo pipefail

usage() {
  cat <<'EOF'
Create a GitHub issue from a design document using `gh`.

Usage:
  ./scripts/ralph/create-issue-from-design-doc.sh --design-doc <path> [--repo <owner/repo>] [--title <title>] [--label <label>...] [--assignee <login>]

Notes:
  - If --title is omitted, the script uses the design doc frontmatter `title:` or first `# Heading`.
  - If the provided design doc path does not exist, it will try `docs/<path>`.

Examples:
  ./scripts/ralph/create-issue-from-design-doc.sh --design-doc docs/desktop-shell-webgpu-renderer-replay-design-issue-778.md
  ./scripts/ralph/create-issue-from-design-doc.sh --design-doc desktop-shell-webgpu-renderer-replay-design-issue-778.md --label ralph --label desktop
EOF
}

DESIGN_DOC_PATH=""
REPO=""
TITLE=""
ASSIGNEE=""
LABELS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --design-doc)
      DESIGN_DOC_PATH="$2"
      shift 2
      ;;
    --repo)
      REPO="$2"
      shift 2
      ;;
    --title)
      TITLE="$2"
      shift 2
      ;;
    --assignee)
      ASSIGNEE="$2"
      shift 2
      ;;
    --label)
      LABELS+=("$2")
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

if [ -z "$DESIGN_DOC_PATH" ]; then
  echo "[ERROR] Required: --design-doc" >&2
  usage
  exit 1
fi

if [ ! -f "$DESIGN_DOC_PATH" ]; then
  candidate="docs/$DESIGN_DOC_PATH"
  if [ -f "$candidate" ]; then
    DESIGN_DOC_PATH="$candidate"
  else
    echo "[ERROR] Design doc not found: $DESIGN_DOC_PATH" >&2
    exit 1
  fi
fi

if [ -z "$TITLE" ]; then
  frontmatter_title="$(
    awk '
      BEGIN { in_frontmatter = 0 }
      NR == 1 && $0 == "---" { in_frontmatter = 1; next }
      in_frontmatter && $0 == "---" { exit }
      in_frontmatter && $0 ~ /^title:[[:space:]]*/ {
        sub(/^title:[[:space:]]*/, "", $0)
        print $0
        exit
      }
    ' "$DESIGN_DOC_PATH"
  )"

  if [ -n "$frontmatter_title" ]; then
    TITLE="$frontmatter_title"
    TITLE="${TITLE%\"}"
    TITLE="${TITLE#\"}"
  else
    heading_title="$(sed -n 's/^# //p' "$DESIGN_DOC_PATH" | head -n 1)"
    if [ -n "$heading_title" ]; then
      TITLE="$heading_title"
    else
      TITLE="$(basename "$DESIGN_DOC_PATH")"
    fi
  fi
fi

summary="$(
  awk '
    BEGIN { in_summary = 0 }
    /^##[[:space:]]+1\\.[[:space:]]+Summary[[:space:]]*$/ { in_summary = 1; next }
    in_summary && /^##[[:space:]]+/ { exit }
    in_summary { print }
  ' "$DESIGN_DOC_PATH"
)"

BODY_FILE="$(mktemp)"
cleanup() {
  rm -f "$BODY_FILE"
}
trap cleanup EXIT

{
  echo "Design document: \`$DESIGN_DOC_PATH\`"
  echo ""
  if [ -n "$(printf '%s' "$summary" | tr -d '[:space:]')" ]; then
    echo "## Summary"
    echo "$summary"
    echo ""
  fi
  echo "## Acceptance Criteria"
  echo "- [ ] Implementation matches the design document"
  echo "- [ ] \`pnpm lint\` passes"
  echo "- [ ] \`pnpm typecheck\` passes"
  echo "- [ ] \`pnpm test\` passes"
} > "$BODY_FILE"

if ! command -v gh >/dev/null 2>&1; then
  echo "[ERROR] gh is required (GitHub CLI)" >&2
  exit 1
fi

ARGS=(issue create --title "$TITLE" --body-file "$BODY_FILE")
if [ -n "$REPO" ]; then
  ARGS+=(--repo "$REPO")
fi
if [ -n "$ASSIGNEE" ]; then
  ARGS+=(--assignee "$ASSIGNEE")
fi
for label in "${LABELS[@]}"; do
  ARGS+=(--label "$label")
done

url="$(gh "${ARGS[@]}")"
number="$(printf '%s' "$url" | sed -E 's|.*/issues/([0-9]+)$|\\1|')"

echo "[INFO] Created: $url"
echo "[INFO] Issue number: $number"
