#!/bin/bash
# Ralph Wiggum - Long-running AI agent loop
# Usage: ./ralph.sh [--runner codex|claude] [--codex|--claude] [--max-iterations N] [max_iterations]

set -e

print_usage() {
    cat <<EOF
Usage: $0 [OPTIONS] [max_iterations]

Options:
    --runner RUNNER      Set runner to 'codex', 'claude', or 'opencode' (overrides RALPH_RUNNER)
     --codex              Use Codex runner (same as --runner codex)
     --claude             Use Claude runner (same as --runner claude)
     --opencode           Use Opencode runner (same as --runner opencode)
    --max-iterations N   Set maximum iterations (default: 10)
    --help               Show this help message

Environment variables:
    RALPH_RUNNER         Runner selection (codex|claude|opencode|auto)
    RALPH_CODEX_APPROVAL_POLICY, RALPH_CODEX_SANDBOX, RALPH_CODEX_DANGEROUS
    RALPH_CLAUDE_SANDBOX, RALPH_CLAUDE_DANGEROUS_SKIP_PERMISSIONS
    RALPH_MODE, RALPH_WORK_DIR, RALPH_STATE_DIR, etc.

If no options are given, the first positional argument is treated as max_iterations.
EOF
}

# Default values
MAX_ITERATIONS=10
RUNNER_ARG=""

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --runner)
            if [[ -z $2 ]]; then
                echo "Error: --runner requires an argument (codex|claude|opencode)" >&2
                exit 1
            fi
            RUNNER_ARG="$2"
            shift 2
            ;;
        --codex)
            RUNNER_ARG="codex"
            shift
            ;;
        --claude)
            RUNNER_ARG="claude"
            shift
            ;;
        --opencode)
            RUNNER_ARG="opencode"
            shift
            ;;
        --max-iterations)
            if [[ -z $2 ]]; then
                echo "Error: --max-iterations requires a number" >&2
                exit 1
            fi
            MAX_ITERATIONS="$2"
            shift 2
            ;;
        --help)
            print_usage
            exit 0
            ;;
        -*)
            echo "Error: Unknown option $1" >&2
            print_usage
            exit 1
            ;;
        *)
            # Positional argument: treat as max_iterations (backward compatibility)
            if [[ $1 =~ ^[0-9]+$ ]]; then
                MAX_ITERATIONS="$1"
            else
                echo "Error: max_iterations must be a number, got '$1'" >&2
                exit 1
            fi
            shift
            ;;
    esac
done

# Apply runner argument to environment if provided
if [[ -n "$RUNNER_ARG" ]]; then
    export RALPH_RUNNER="$RUNNER_ARG"
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${RALPH_WORK_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# State lives in a ralph/ subfolder of working directory by default
RALPH_STATE_DIR="${RALPH_STATE_DIR:-$WORK_DIR/ralph}"
PRD_FILE="$RALPH_STATE_DIR/prd.json"
ISSUE_FILE="$RALPH_STATE_DIR/issue.json"
PROGRESS_FILE="$RALPH_STATE_DIR/progress.txt"
ARCHIVE_DIR="$RALPH_STATE_DIR/.archive"
LAST_BRANCH_FILE="$RALPH_STATE_DIR/.last-branch"
OPEN_QUESTIONS_FILE="$RALPH_STATE_DIR/open-questions.md"
COVERAGE_FAILURES_FILE="$RALPH_STATE_DIR/coverage-failures.md"

# Prompt templates stay with the script
PROMPT_PRD_FILE="$SCRIPT_DIR/prompt.md"
PROMPT_ISSUE_DESIGN_FILE="$SCRIPT_DIR/prompt.issue.design.md"
PROMPT_ISSUE_IMPLEMENT_FILE="$SCRIPT_DIR/prompt.issue.implement.md"
PROMPT_ISSUE_REVIEW_FILE="$SCRIPT_DIR/prompt.issue.review.md"
PROMPT_ISSUE_COVERAGE_FILE="$SCRIPT_DIR/prompt.issue.coverage.md"
PROMPT_ISSUE_COVERAGE_FIX_FILE="$SCRIPT_DIR/prompt.issue.coverage.fix.md"
PROMPT_ISSUE_SONAR_FILE="$SCRIPT_DIR/prompt.issue.sonar.md"
PROMPT_ISSUE_QUESTIONS_FILE="$SCRIPT_DIR/prompt.issue.questions.md"

# Select mode + config file
MODE="${RALPH_MODE:-auto}"
CONFIG_FILE=""
PROMPT_FILE=""
ISSUE_PHASE=""
ISSUE_STATUS_IMPLEMENTED="false"
ISSUE_STATUS_PR_CREATED="false"
ISSUE_STATUS_PR_DESCRIPTION_READY="false"
ISSUE_STATUS_REVIEW_CLEAN="false"
ISSUE_STATUS_COVERAGE_CLEAN="false"
ISSUE_STATUS_COVERAGE_NEEDS_FIX="false"
ISSUE_STATUS_SONAR_CLEAN="false"
ISSUE_PR_NUMBER=""
ISSUE_PR_URL=""

if [ "$MODE" = "issue" ] || ([ "$MODE" = "auto" ] && [ -f "$ISSUE_FILE" ]); then
  MODE="issue"
  CONFIG_FILE="$ISSUE_FILE"
  PROMPT_FILE="$PROMPT_ISSUE_IMPLEMENT_FILE"
elif [ "$MODE" = "prd" ] || ([ "$MODE" = "auto" ] && [ -f "$PRD_FILE" ]); then
  MODE="prd"
  CONFIG_FILE="$PRD_FILE"
  PROMPT_FILE="$PROMPT_PRD_FILE"
else
  echo "[ERROR] No Ralph config found in: $RALPH_STATE_DIR"
  echo "[ERROR] Create one of:"
  echo "        - $PRD_FILE (PRD mode)"
  echo "        - $ISSUE_FILE (Issue mode)"
  echo "[ERROR] Or set RALPH_MODE=prd|issue"
  exit 1
fi

# Validate config exists (covers explicit RALPH_MODE=issue|prd)
if [ ! -f "$CONFIG_FILE" ]; then
  echo "[ERROR] Config file not found: $CONFIG_FILE"
  exit 1
fi

# Ensure state dir exists for auxiliary files (progress, archive, last-message)
mkdir -p "$RALPH_STATE_DIR"

pr_body_meets_requirements() {
  local body="$1"
  local issueNumber="$2"

  if [ -z "$body" ] || [ -z "$issueNumber" ] || [ "$issueNumber" = "null" ]; then
    return 1
  fi

  local fixesPattern="fixes[[:space:]]*#[[:space:]]*${issueNumber}([^0-9]|$)"
  if ! printf '%s\n' "$body" | grep -Eiq "$fixesPattern"; then
    return 1
  fi

  local nonMetadata
  nonMetadata="$(
    printf '%s\n' "$body" \
      | grep -Eiv "^[[:space:]]*fixes[[:space:]]*#[[:space:]]*${issueNumber}([^0-9]|$)" \
      | grep -Eiv '^[[:space:]]*#{1,6}[[:space:]]' \
      | grep -Eiv '^[[:space:]]*$' \
      || true
  )"

  if [ -z "$nonMetadata" ]; then
    return 1
  fi

  return 0
}

select_issue_phase() {
  local implemented prCreated prDescriptionReady prNumber prUrl reviewClean coverageClean coverageNeedsFix sonarClean hasOpenQuestions hasCoverageFailures
  local designDocPath designDocResolved hasDesignDoc

  implemented=$(jq -r '.status.implemented // false' "$ISSUE_FILE" 2>/dev/null || echo "false")
  prCreated=$(jq -r '.status.prCreated // false' "$ISSUE_FILE" 2>/dev/null || echo "false")
  prDescriptionReady=$(jq -r '.status.prDescriptionReady // false' "$ISSUE_FILE" 2>/dev/null || echo "false")
  prNumber=$(jq -r '.pullRequest.number // empty' "$ISSUE_FILE" 2>/dev/null || echo "")
  prUrl=$(jq -r '.pullRequest.url // empty' "$ISSUE_FILE" 2>/dev/null || echo "")
  reviewClean=$(jq -r '.status.reviewClean // false' "$ISSUE_FILE" 2>/dev/null || echo "false")
  coverageClean=$(jq -r '.status.coverageClean // false' "$ISSUE_FILE" 2>/dev/null || echo "false")
  coverageNeedsFix=$(jq -r '.status.coverageNeedsFix // false' "$ISSUE_FILE" 2>/dev/null || echo "false")
  sonarClean=$(jq -r '.status.sonarClean // false' "$ISSUE_FILE" 2>/dev/null || echo "false")
  local originalCoverageClean originalCoverageNeedsFix
  originalCoverageClean="$coverageClean"
  originalCoverageNeedsFix="$coverageNeedsFix"

  hasOpenQuestions="false"
  if [ -s "$OPEN_QUESTIONS_FILE" ]; then
    hasOpenQuestions="true"
  fi

  hasCoverageFailures="false"
  if [ -s "$COVERAGE_FAILURES_FILE" ]; then
    hasCoverageFailures="true"
  fi

  # Treat a recorded PR as prCreated even if the boolean wasn't set.
  if [ "$prCreated" != "true" ]; then
    if ([ -n "$prNumber" ] && [ "$prNumber" != "null" ]) || ([ -n "$prUrl" ] && [ "$prUrl" != "null" ]); then
      prCreated="true"
    fi
  fi

  # If no PR is recorded yet, try to discover an existing PR for this head branch.
  if [ "$prCreated" != "true" ] && ([ -z "$prNumber" ] || [ "$prNumber" = "null" ]) && ([ -z "$prUrl" ] || [ "$prUrl" = "null" ]); then
    if command -v gh >/dev/null 2>&1; then
      local branchName repo prList foundNumber foundUrl tmpFile
      branchName=$(jq -r '.branchName // empty' "$ISSUE_FILE" 2>/dev/null || echo "")
      repo=$(jq -r '.issue.repo // empty' "$ISSUE_FILE" 2>/dev/null || echo "")

      if [ -n "$branchName" ]; then
        if [ -n "$repo" ]; then
          prList=$(gh pr list --repo "$repo" --head "$branchName" --state open --json number,url 2>/dev/null || true)
        else
          prList=$(gh pr list --head "$branchName" --state open --json number,url 2>/dev/null || true)
        fi

        foundNumber=$(echo "$prList" | jq -r '.[0].number // empty' 2>/dev/null || echo "")
        foundUrl=$(echo "$prList" | jq -r '.[0].url // empty' 2>/dev/null || echo "")

        if [ -n "$foundNumber" ] && [ "$foundNumber" != "null" ]; then
          prCreated="true"
          prNumber="$foundNumber"
          prUrl="$foundUrl"

          tmpFile="$(mktemp "$RALPH_STATE_DIR/issue.json.tmp.XXXXXX")"
          jq \
            --argjson prNumber "$prNumber" \
            --arg prUrl "$prUrl" \
            '.status.prCreated=true
            | .pullRequest = (.pullRequest // {})
            | .pullRequest.number=$prNumber
            | .pullRequest.url=$prUrl' "$ISSUE_FILE" > "$tmpFile" 2>/dev/null || true
          if [ -s "$tmpFile" ]; then
            mv "$tmpFile" "$ISSUE_FILE"
          else
            rm -f "$tmpFile"
          fi
      fi
    fi
  fi

  fi

  # Best-effort PR body validation for Issue-mode PR descriptions.
  # If `gh` is available, keep `status.prDescriptionReady` synced with the actual PR body.
  if [ "$prCreated" = "true" ] && command -v gh >/dev/null 2>&1; then
    local issueNumber repo branchName prViewArg prJson prBody tmpFile currentPrDescriptionReady
    issueNumber=$(jq -r '.issue.number // .issueNumber // empty' "$ISSUE_FILE" 2>/dev/null || echo "")
    repo=$(jq -r '.issue.repo // empty' "$ISSUE_FILE" 2>/dev/null || echo "")
    branchName=$(jq -r '.branchName // empty' "$ISSUE_FILE" 2>/dev/null || echo "")

    prViewArg=""
    if [ -n "$prNumber" ] && [ "$prNumber" != "null" ]; then
      prViewArg="$prNumber"
    elif [ -n "$branchName" ]; then
      prViewArg="$branchName"
    fi

    prJson=""
    if [ -n "$prViewArg" ]; then
      if [ -n "$repo" ]; then
        prJson=$(gh pr view "$prViewArg" --repo "$repo" --json body 2>/dev/null || true)
      else
        prJson=$(gh pr view "$prViewArg" --json body 2>/dev/null || true)
      fi
    fi

    prBody=$(echo "$prJson" | jq -r '.body // empty' 2>/dev/null || echo "")
    if [ -n "$prBody" ]; then
      if pr_body_meets_requirements "$prBody" "$issueNumber"; then
        prDescriptionReady="true"
      else
        prDescriptionReady="false"
      fi

      currentPrDescriptionReady=$(jq -r '.status.prDescriptionReady // empty' "$ISSUE_FILE" 2>/dev/null || echo "")
      if [ "$currentPrDescriptionReady" != "$prDescriptionReady" ]; then
        tmpFile="$(mktemp "$RALPH_STATE_DIR/issue.json.tmp.XXXXXX")"
        jq \
          --argjson prDescriptionReady "$prDescriptionReady" \
          '.status = (.status // {})
          | .status.prDescriptionReady=$prDescriptionReady' "$ISSUE_FILE" > "$tmpFile" 2>/dev/null || true
        if [ -s "$tmpFile" ]; then
          mv "$tmpFile" "$ISSUE_FILE"
        else
          rm -f "$tmpFile"
        fi
      fi
    fi
  fi

  # Treat a recorded coverage failures file as a "needs fix" signal even if the boolean wasn't set.
  if [ "$hasCoverageFailures" = "true" ]; then
    coverageNeedsFix="true"
    coverageClean="false"
  fi

  # A fix-needed flag implies coverage is not clean yet.
  if [ "$coverageNeedsFix" = "true" ]; then
    coverageClean="false"
  fi

  # Keep `status.coverage*` synchronized if we inferred state from files.
  if [ "$coverageClean" != "$originalCoverageClean" ] || [ "$coverageNeedsFix" != "$originalCoverageNeedsFix" ]; then
    local tmpFile
    tmpFile="$(mktemp "$RALPH_STATE_DIR/issue.json.tmp.XXXXXX")"
    jq \
      --argjson coverageClean "$coverageClean" \
      --argjson coverageNeedsFix "$coverageNeedsFix" \
      '.status = (.status // {})
      | .status.coverageClean=$coverageClean
      | .status.coverageNeedsFix=$coverageNeedsFix' "$ISSUE_FILE" > "$tmpFile" 2>/dev/null || true
    if [ -s "$tmpFile" ]; then
      mv "$tmpFile" "$ISSUE_FILE"
    else
      rm -f "$tmpFile"
    fi
  fi

  ISSUE_STATUS_IMPLEMENTED="$implemented"
  ISSUE_STATUS_PR_CREATED="$prCreated"
  ISSUE_STATUS_PR_DESCRIPTION_READY="$prDescriptionReady"
  ISSUE_STATUS_REVIEW_CLEAN="$reviewClean"
  ISSUE_STATUS_COVERAGE_CLEAN="$coverageClean"
  ISSUE_STATUS_COVERAGE_NEEDS_FIX="$coverageNeedsFix"
  ISSUE_STATUS_SONAR_CLEAN="$sonarClean"
  ISSUE_PR_NUMBER="$prNumber"
  ISSUE_PR_URL="$prUrl"

  hasDesignDoc="false"
  designDocPath=$(jq -r '.designDocPath // .designDoc // empty' "$ISSUE_FILE" 2>/dev/null || echo "")
  if [ -n "$designDocPath" ] && [ "$designDocPath" != "null" ]; then
    designDocResolved="$designDocPath"
    if [[ "$designDocResolved" != /* ]]; then
      designDocResolved="$WORK_DIR/$designDocResolved"
    fi
    if [ -f "$designDocResolved" ]; then
      hasDesignDoc="true"
    fi
  fi

  if [ "$hasDesignDoc" != "true" ]; then
    ISSUE_PHASE="design"
    PROMPT_FILE="$PROMPT_ISSUE_DESIGN_FILE"
    return
  fi

  # If there are open questions, resolve them in a dedicated pass before continuing the normal flow.
  if [ "$implemented" = "true" ] && [ "$prCreated" = "true" ] && [ "$prDescriptionReady" = "true" ] && [ "$hasOpenQuestions" = "true" ]; then
    ISSUE_PHASE="questions"
    PROMPT_FILE="$PROMPT_ISSUE_QUESTIONS_FILE"
    return
  fi

  if [ "$implemented" != "true" ] || [ "$prCreated" != "true" ] || [ "$prDescriptionReady" != "true" ]; then
    ISSUE_PHASE="implement"
    PROMPT_FILE="$PROMPT_ISSUE_IMPLEMENT_FILE"
  elif [ "$reviewClean" != "true" ]; then
    ISSUE_PHASE="review"
    PROMPT_FILE="$PROMPT_ISSUE_REVIEW_FILE"
  elif [ "$coverageNeedsFix" = "true" ]; then
    ISSUE_PHASE="coverage-fix"
    PROMPT_FILE="$PROMPT_ISSUE_COVERAGE_FIX_FILE"
  elif [ "$coverageClean" != "true" ]; then
    ISSUE_PHASE="coverage"
    PROMPT_FILE="$PROMPT_ISSUE_COVERAGE_FILE"
  elif [ "$sonarClean" != "true" ]; then
    ISSUE_PHASE="sonar"
    PROMPT_FILE="$PROMPT_ISSUE_SONAR_FILE"
  else
    ISSUE_PHASE="complete"
    PROMPT_FILE="$PROMPT_ISSUE_SONAR_FILE"
  fi
}

# Runner selection
RUNNER="${RALPH_RUNNER:-auto}"
if [ "$RUNNER" = "auto" ]; then
  if command -v codex >/dev/null 2>&1; then
    RUNNER="codex"
  elif command -v claude >/dev/null 2>&1; then
    RUNNER="claude"
  elif command -v opencode >/dev/null 2>&1; then
    RUNNER="opencode"
  else
    echo "[ERROR] No supported agent runner found. Install Codex CLI (\`codex\`), Claude CLI (\`claude\`), or Opencode CLI (\`opencode\`)."
    exit 1
  fi
fi

CODEX_APPROVAL_POLICY="${RALPH_CODEX_APPROVAL_POLICY:-never}"
CODEX_SANDBOX="${RALPH_CODEX_SANDBOX:-danger-full-access}"
CODEX_DANGEROUS="${RALPH_CODEX_DANGEROUS:-1}"

CLAUDE_SANDBOX="${RALPH_CLAUDE_SANDBOX:-1}"
CLAUDE_DANGEROUS_SKIP_PERMISSIONS="${RALPH_CLAUDE_DANGEROUS_SKIP_PERMISSIONS:-1}"

OUTPUT_MODE="${RALPH_OUTPUT_MODE:-compact}"
PRINT_PROMPT="${RALPH_PRINT_PROMPT:-1}"
LAST_RUN_LOG_FILE="${RALPH_LAST_RUN_LOG_FILE:-$RALPH_STATE_DIR/last-run.log}"

echo "╔═══════════════════════════════════════════════════════╗"
echo "║              Ralph Wiggum - AI Agent Loop             ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""
echo "[DEBUG] Script directory: $SCRIPT_DIR"
echo "[DEBUG] Working directory: $WORK_DIR"
echo "[DEBUG] Ralph state directory: $RALPH_STATE_DIR"
echo "[DEBUG] Mode: $MODE"
echo "[DEBUG] Config file: $CONFIG_FILE"
echo "[DEBUG] Progress file: $PROGRESS_FILE"
echo "[DEBUG] Runner: $RUNNER"
echo "[DEBUG] Output mode: $OUTPUT_MODE"
if [ "$RUNNER" = "codex" ]; then
  echo "[DEBUG] Codex approval policy: $CODEX_APPROVAL_POLICY"
  echo "[DEBUG] Codex sandbox: $CODEX_SANDBOX"
  echo "[DEBUG] Codex dangerous bypass: $CODEX_DANGEROUS"
elif [ "$RUNNER" = "claude" ]; then
  echo "[DEBUG] Claude sandbox: $CLAUDE_SANDBOX"
  echo "[DEBUG] Claude dangerous skip permissions: $CLAUDE_DANGEROUS_SKIP_PERMISSIONS"
fi
if [ "$OUTPUT_MODE" != "stream" ]; then
  echo "[DEBUG] Runner log file: $LAST_RUN_LOG_FILE"
fi
echo ""

if [ "$MODE" = "issue" ]; then
  select_issue_phase
  echo "[DEBUG] Phase: $ISSUE_PHASE"
  echo "[DEBUG] Prompt file: $PROMPT_FILE"
else
  echo "[DEBUG] Prompt file: $PROMPT_FILE"
fi
echo ""

if [ ! -f "$PROMPT_FILE" ]; then
  echo "[ERROR] Prompt file not found: $PROMPT_FILE"
  exit 1
fi

echo "[DEBUG] Config file found: $(wc -c < "$CONFIG_FILE") bytes"

# Archive previous run if branch changed
if [ -f "$LAST_BRANCH_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
  LAST_BRANCH=$(cat "$LAST_BRANCH_FILE" 2>/dev/null || echo "")

  echo "[DEBUG] Current branch from config: ${CURRENT_BRANCH:-<none>}"
  echo "[DEBUG] Last branch: ${LAST_BRANCH:-<none>}"

  if [ -n "$CURRENT_BRANCH" ] && [ -n "$LAST_BRANCH" ] && [ "$CURRENT_BRANCH" != "$LAST_BRANCH" ]; then
    # Archive the previous run
    DATE=$(date +%Y-%m-%d)
    # Strip "ralph/" prefix from branch name for folder
    FOLDER_NAME=$(echo "$LAST_BRANCH" | sed 's|^ralph/||')
    ARCHIVE_FOLDER="$ARCHIVE_DIR/$DATE-$FOLDER_NAME"

    echo "[INFO] Branch changed, archiving previous run: $LAST_BRANCH"
    mkdir -p "$ARCHIVE_FOLDER"
    [ -f "$PRD_FILE" ] && cp "$PRD_FILE" "$ARCHIVE_FOLDER/"
    [ -f "$ISSUE_FILE" ] && cp "$ISSUE_FILE" "$ARCHIVE_FOLDER/"
    [ -f "$PROGRESS_FILE" ] && cp "$PROGRESS_FILE" "$ARCHIVE_FOLDER/"
    [ -f "$RALPH_STATE_DIR/review.md" ] && cp "$RALPH_STATE_DIR/review.md" "$ARCHIVE_FOLDER/"
    [ -f "$RALPH_STATE_DIR/sonar-issues.json" ] && cp "$RALPH_STATE_DIR/sonar-issues.json" "$ARCHIVE_FOLDER/"
    [ -f "$OPEN_QUESTIONS_FILE" ] && cp "$OPEN_QUESTIONS_FILE" "$ARCHIVE_FOLDER/"
    [ -f "$COVERAGE_FAILURES_FILE" ] && cp "$COVERAGE_FAILURES_FILE" "$ARCHIVE_FOLDER/"
    echo "[INFO] Archived to: $ARCHIVE_FOLDER"

    # Reset progress file for new run
    echo "# Ralph Progress Log" > "$PROGRESS_FILE"
    echo "Started: $(date)" >> "$PROGRESS_FILE"
    echo "---" >> "$PROGRESS_FILE"
  fi
fi

# Track current branch
CURRENT_BRANCH=$(jq -r '.branchName // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
if [ -n "$CURRENT_BRANCH" ]; then
  mkdir -p "$RALPH_STATE_DIR"
  echo "$CURRENT_BRANCH" > "$LAST_BRANCH_FILE"
  echo "[DEBUG] Tracking branch: $CURRENT_BRANCH"
fi

# Initialize progress file if it doesn't exist
if [ ! -f "$PROGRESS_FILE" ]; then
  echo "[INFO] Creating new progress file"
  echo "# Ralph Progress Log" > "$PROGRESS_FILE"
  echo "Started: $(date)" >> "$PROGRESS_FILE"
  echo "---" >> "$PROGRESS_FILE"
fi

# Show summary
echo ""
echo "[INFO] Ralph Summary:"
if [ "$MODE" = "prd" ]; then
  STORY_COUNT=$(jq '.userStories | length' "$PRD_FILE" 2>/dev/null || echo "0")
  PASSING_COUNT=$(jq '[.userStories[] | select(.passes == true)] | length' "$PRD_FILE" 2>/dev/null || echo "0")
  echo "       Mode: PRD"
  echo "       Stories: $PASSING_COUNT / $STORY_COUNT passing"
else
  ISSUE_NUMBER=$(jq -r '.issue.number // .issueNumber // empty' "$ISSUE_FILE" 2>/dev/null || echo "")
  DESIGN_DOC=$(jq -r '.designDocPath // .designDoc // empty' "$ISSUE_FILE" 2>/dev/null || echo "")
  select_issue_phase

  echo "       Mode: Issue"
  echo "       Issue: ${ISSUE_NUMBER:-<unknown>}"
  echo "       Design doc: ${DESIGN_DOC:-<none>}"
  if [ -n "$ISSUE_PR_NUMBER" ] && [ "$ISSUE_PR_NUMBER" != "null" ]; then
    echo "       PR: #$ISSUE_PR_NUMBER"
  elif [ -n "$ISSUE_PR_URL" ] && [ "$ISSUE_PR_URL" != "null" ]; then
    echo "       PR: $ISSUE_PR_URL"
  else
    echo "       PR: <none>"
  fi
  echo "       Status: implemented=$ISSUE_STATUS_IMPLEMENTED, prCreated=$ISSUE_STATUS_PR_CREATED, prDescriptionReady=$ISSUE_STATUS_PR_DESCRIPTION_READY, reviewClean=$ISSUE_STATUS_REVIEW_CLEAN, coverageClean=$ISSUE_STATUS_COVERAGE_CLEAN, coverageNeedsFix=$ISSUE_STATUS_COVERAGE_NEEDS_FIX, sonarClean=$ISSUE_STATUS_SONAR_CLEAN"
  echo "       Phase: $ISSUE_PHASE"
fi
echo ""

echo "Starting Ralph - Max iterations: $MAX_ITERATIONS"
echo ""

LAST_PRINTED_PROMPT_FILE=""

# Fast exit if already complete
if [ "$MODE" = "prd" ]; then
  REMAINING=$(jq '[.userStories[] | select(.passes != true)] | length' "$PRD_FILE" 2>/dev/null || echo "?")
  if [ "$REMAINING" = "0" ]; then
    echo "╔═══════════════════════════════════════════════════════╗"
    echo "║           Ralph completed all tasks!                  ║"
    echo "╚═══════════════════════════════════════════════════════╝"
    echo "All PRD stories are already passing."
    exit 0
  fi
else
  select_issue_phase
  if [ "$ISSUE_STATUS_IMPLEMENTED" = "true" ] && [ "$ISSUE_STATUS_PR_CREATED" = "true" ] && [ "$ISSUE_STATUS_PR_DESCRIPTION_READY" = "true" ] && [ "$ISSUE_STATUS_REVIEW_CLEAN" = "true" ] && [ "$ISSUE_STATUS_COVERAGE_CLEAN" = "true" ] && [ "$ISSUE_STATUS_COVERAGE_NEEDS_FIX" != "true" ] && [ "$ISSUE_STATUS_SONAR_CLEAN" = "true" ]; then
    echo "╔═══════════════════════════════════════════════════════╗"
    echo "║           Ralph completed all tasks!                  ║"
    echo "╚═══════════════════════════════════════════════════════╝"
    echo "Issue workflow is already marked complete."
    exit 0
  fi
fi

for i in $(seq 1 $MAX_ITERATIONS); do
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  Ralph Iteration $i of $MAX_ITERATIONS"
  echo "  Started: $(date)"
  echo "═══════════════════════════════════════════════════════"

  # Show current story status
  if [ "$MODE" = "prd" ]; then
    REMAINING=$(jq '[.userStories[] | select(.passes != true)] | length' "$PRD_FILE" 2>/dev/null || echo "?")
    echo "[DEBUG] Stories remaining: $REMAINING"
  else
    select_issue_phase
    echo "[DEBUG] Phase: $ISSUE_PHASE"
    echo "[DEBUG] Issue status: implemented=$ISSUE_STATUS_IMPLEMENTED, prCreated=$ISSUE_STATUS_PR_CREATED, prDescriptionReady=$ISSUE_STATUS_PR_DESCRIPTION_READY, reviewClean=$ISSUE_STATUS_REVIEW_CLEAN, coverageClean=$ISSUE_STATUS_COVERAGE_CLEAN, coverageNeedsFix=$ISSUE_STATUS_COVERAGE_NEEDS_FIX, sonarClean=$ISSUE_STATUS_SONAR_CLEAN"
  fi

  echo "[DEBUG] Prompt file: $PROMPT_FILE"
  if [ ! -f "$PROMPT_FILE" ]; then
    echo "[ERROR] Prompt file not found: $PROMPT_FILE"
    exit 1
  fi

  if [ "$OUTPUT_MODE" != "stream" ] && [ "$PRINT_PROMPT" = "1" ] && [ "$PROMPT_FILE" != "$LAST_PRINTED_PROMPT_FILE" ]; then
    echo ""
    echo "----- Prompt ($PROMPT_FILE) -----"
    cat "$PROMPT_FILE"
    echo "----- End Prompt -----"
    echo ""
    LAST_PRINTED_PROMPT_FILE="$PROMPT_FILE"
  fi

  # Run the agent with the ralph prompt
  echo "[DEBUG] Invoking agent runner ($RUNNER)..."
  START_TIME=$(date +%s)
  LAST_MESSAGE_FILE="$RALPH_STATE_DIR/last-message.txt"
  rm -f "$LAST_MESSAGE_FILE" 2>/dev/null || true

  if [ "$RUNNER" = "codex" ]; then
    if [ "$OUTPUT_MODE" = "stream" ]; then
      # In stream mode, write to both log file AND stderr for real-time viewing
      rm -f "$LAST_RUN_LOG_FILE" 2>/dev/null || true
      : > "$LAST_RUN_LOG_FILE"
      if [ "$CODEX_DANGEROUS" = "1" ]; then
        OUTPUT=$(codex --ask-for-approval "$CODEX_APPROVAL_POLICY" exec --dangerously-bypass-approvals-and-sandbox -C "$WORK_DIR" --color never --output-last-message "$LAST_MESSAGE_FILE" - < "$PROMPT_FILE" 2>&1 | tee "$LAST_RUN_LOG_FILE" >(cat >&2)) || true
      else
        OUTPUT=$(codex --ask-for-approval "$CODEX_APPROVAL_POLICY" exec --sandbox "$CODEX_SANDBOX" -C "$WORK_DIR" --color never --output-last-message "$LAST_MESSAGE_FILE" - < "$PROMPT_FILE" 2>&1 | tee "$LAST_RUN_LOG_FILE" >(cat >&2)) || true
        if echo "$OUTPUT" | grep -qi "error running landlock"; then
          echo ""
          echo "[WARN] Codex sandbox failed (landlock). Retrying without sandbox."
          echo "[WARN] To bypass the sandbox next time, set: RALPH_CODEX_DANGEROUS=1"
          echo ""
          OUTPUT=$(codex --ask-for-approval "$CODEX_APPROVAL_POLICY" exec --dangerously-bypass-approvals-and-sandbox -C "$WORK_DIR" --color never --output-last-message "$LAST_MESSAGE_FILE" - < "$PROMPT_FILE" 2>&1 | tee "$LAST_RUN_LOG_FILE" >(cat >&2)) || true
        fi
      fi
    else
      rm -f "$LAST_RUN_LOG_FILE" 2>/dev/null || true
      : > "$LAST_RUN_LOG_FILE"

      if [ "$CODEX_DANGEROUS" = "1" ]; then
        codex --ask-for-approval "$CODEX_APPROVAL_POLICY" exec --dangerously-bypass-approvals-and-sandbox -C "$WORK_DIR" --color never --output-last-message "$LAST_MESSAGE_FILE" - < "$PROMPT_FILE" > "$LAST_RUN_LOG_FILE" 2>&1 || true
      else
        codex --ask-for-approval "$CODEX_APPROVAL_POLICY" exec --sandbox "$CODEX_SANDBOX" -C "$WORK_DIR" --color never --output-last-message "$LAST_MESSAGE_FILE" - < "$PROMPT_FILE" > "$LAST_RUN_LOG_FILE" 2>&1 || true
        if grep -qi "error running landlock" "$LAST_RUN_LOG_FILE"; then
          echo ""
          echo "[WARN] Codex sandbox failed (landlock). Retrying without sandbox."
          echo "[WARN] To bypass the sandbox next time, set: RALPH_CODEX_DANGEROUS=1"
          echo ""

          echo "" >> "$LAST_RUN_LOG_FILE"
          echo "[WARN] Codex sandbox failed (landlock). Retrying without sandbox." >> "$LAST_RUN_LOG_FILE"
          codex --ask-for-approval "$CODEX_APPROVAL_POLICY" exec --dangerously-bypass-approvals-and-sandbox -C "$WORK_DIR" --color never --output-last-message "$LAST_MESSAGE_FILE" - < "$PROMPT_FILE" >> "$LAST_RUN_LOG_FILE" 2>&1 || true
        fi
      fi

      OUTPUT=$(cat "$LAST_MESSAGE_FILE" 2>/dev/null || true)
      if [ ! -s "$LAST_MESSAGE_FILE" ] && [ -s "$LAST_RUN_LOG_FILE" ]; then
        OUTPUT=$(tail -n 200 "$LAST_RUN_LOG_FILE" 2>/dev/null || true)
      fi
    fi
  elif [ "$RUNNER" = "claude" ]; then
    # Build claude command with configurable sandbox and dangerous skip permissions
    CLAUDE_ARGS=(claude -p)
    SANDBOX_VALUE=""
    if [ "$CLAUDE_SANDBOX" != "0" ] && [ "$CLAUDE_SANDBOX" != "" ]; then
      SANDBOX_VALUE="$CLAUDE_SANDBOX"
      case "$SANDBOX_VALUE" in
        [Tt][Rr][Uu][Ee]) SANDBOX_VALUE="1" ;;
        [Ff][Aa][Ll][Ss][Ee]) SANDBOX_VALUE="0" ;;
      esac
    fi
    if [ "$CLAUDE_DANGEROUS_SKIP_PERMISSIONS" != "0" ] && [ "$CLAUDE_DANGEROUS_SKIP_PERMISSIONS" != "" ]; then
      CLAUDE_ARGS+=("--dangerously-skip-permissions")
    fi
    if [ "$OUTPUT_MODE" = "stream" ]; then
      # In stream mode, write to both log file AND stderr for real-time viewing
      rm -f "$LAST_RUN_LOG_FILE" 2>/dev/null || true
      : > "$LAST_RUN_LOG_FILE"
      if [ -n "$SANDBOX_VALUE" ]; then
        OUTPUT=$(IS_SANDBOX="$SANDBOX_VALUE" "${CLAUDE_ARGS[@]}" "$(cat "$PROMPT_FILE")" 2>&1 | tee "$LAST_RUN_LOG_FILE" >(cat >&2)) || true
      else
        OUTPUT=$("${CLAUDE_ARGS[@]}" "$(cat "$PROMPT_FILE")" 2>&1 | tee "$LAST_RUN_LOG_FILE" >(cat >&2)) || true
      fi
    else
      rm -f "$LAST_RUN_LOG_FILE" 2>/dev/null || true
      : > "$LAST_RUN_LOG_FILE"
      if [ -n "$SANDBOX_VALUE" ]; then
        IS_SANDBOX="$SANDBOX_VALUE" "${CLAUDE_ARGS[@]}" "$(cat "$PROMPT_FILE")" > "$LAST_RUN_LOG_FILE" 2>&1 || true
      else
        "${CLAUDE_ARGS[@]}" "$(cat "$PROMPT_FILE")" > "$LAST_RUN_LOG_FILE" 2>&1 || true
      fi
      OUTPUT=$(cat "$LAST_RUN_LOG_FILE" 2>/dev/null || true)
    fi
  elif [ "$RUNNER" = "opencode" ]; then
    # Build opencode command with non-interactive run
    OPENCODE_CMD="opencode"
    if [ "$OUTPUT_MODE" = "stream" ]; then
      # In stream mode, write to both log file AND stderr for real-time viewing
      rm -f "$LAST_RUN_LOG_FILE" 2>/dev/null || true
      : > "$LAST_RUN_LOG_FILE"
      OUTPUT=$(cd "$WORK_DIR" && $OPENCODE_CMD run "$(cat "$PROMPT_FILE")" 2>&1 | tee "$LAST_RUN_LOG_FILE" >(cat >&2)) || true
    else
      rm -f "$LAST_RUN_LOG_FILE" 2>/dev/null || true
      : > "$LAST_RUN_LOG_FILE"
      (cd "$WORK_DIR" && $OPENCODE_CMD run "$(cat "$PROMPT_FILE")" > "$LAST_RUN_LOG_FILE" 2>&1) || true
      OUTPUT=$(cat "$LAST_RUN_LOG_FILE" 2>/dev/null || true)
    fi
  else
    echo "[ERROR] Unsupported runner: $RUNNER"
    exit 1
  fi

  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))

  echo ""
  echo "[DEBUG] Agent finished in ${DURATION}s"
  echo "[DEBUG] Output length: $(echo "$OUTPUT" | wc -c) bytes"

  if [ "$OUTPUT_MODE" != "stream" ]; then
    echo ""
    echo "----- Agent Response -----"
    if [ -s "$LAST_MESSAGE_FILE" ]; then
      cat "$LAST_MESSAGE_FILE"
    elif [ -s "$LAST_RUN_LOG_FILE" ]; then
      cat "$LAST_RUN_LOG_FILE"
    else
      echo "[WARN] No response captured."
    fi
    echo "----- End Response -----"
  fi

  # Check for completion signal
  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>" \
    || ([ -f "$LAST_MESSAGE_FILE" ] && grep -q "<promise>COMPLETE</promise>" "$LAST_MESSAGE_FILE") \
    || ([ "$OUTPUT_MODE" != "stream" ] && [ -f "$LAST_RUN_LOG_FILE" ] && grep -q "<promise>COMPLETE</promise>" "$LAST_RUN_LOG_FILE"); then
    echo ""
    echo "╔═══════════════════════════════════════════════════════╗"
    echo "║           Ralph completed all tasks!                  ║"
    echo "╚═══════════════════════════════════════════════════════╝"
    echo "Completed at iteration $i of $MAX_ITERATIONS"
    exit 0
  fi

  # Stop condition based on config state (backup to promise token)
  if [ "$MODE" = "prd" ]; then
    REMAINING=$(jq '[.userStories[] | select(.passes != true)] | length' "$PRD_FILE" 2>/dev/null || echo "?")
    NEW_PASSING=$(jq '[.userStories[] | select(.passes == true)] | length' "$PRD_FILE" 2>/dev/null || echo "0")
    echo "[DEBUG] Stories now passing: $NEW_PASSING / $STORY_COUNT"

    if [ "$REMAINING" = "0" ]; then
      echo ""
      echo "╔═══════════════════════════════════════════════════════╗"
      echo "║           Ralph completed all tasks!                  ║"
      echo "╚═══════════════════════════════════════════════════════╝"
      echo "Completed at iteration $i of $MAX_ITERATIONS"
      exit 0
    fi
  else
    select_issue_phase
    echo "[DEBUG] Issue status: implemented=$ISSUE_STATUS_IMPLEMENTED, prCreated=$ISSUE_STATUS_PR_CREATED, prDescriptionReady=$ISSUE_STATUS_PR_DESCRIPTION_READY, reviewClean=$ISSUE_STATUS_REVIEW_CLEAN, coverageClean=$ISSUE_STATUS_COVERAGE_CLEAN, coverageNeedsFix=$ISSUE_STATUS_COVERAGE_NEEDS_FIX, sonarClean=$ISSUE_STATUS_SONAR_CLEAN"

    if [ "$ISSUE_STATUS_IMPLEMENTED" = "true" ] && [ "$ISSUE_STATUS_PR_CREATED" = "true" ] && [ "$ISSUE_STATUS_PR_DESCRIPTION_READY" = "true" ] && [ "$ISSUE_STATUS_REVIEW_CLEAN" = "true" ] && [ "$ISSUE_STATUS_COVERAGE_CLEAN" = "true" ] && [ "$ISSUE_STATUS_COVERAGE_NEEDS_FIX" != "true" ] && [ "$ISSUE_STATUS_SONAR_CLEAN" = "true" ]; then
      echo ""
      echo "╔═══════════════════════════════════════════════════════╗"
      echo "║           Ralph completed all tasks!                  ║"
      echo "╚═══════════════════════════════════════════════════════╝"
      echo "Completed at iteration $i of $MAX_ITERATIONS"
      exit 0
    fi
  fi

  echo "[INFO] Iteration $i complete. Continuing..."
  sleep 2
done

echo ""
echo "╔═══════════════════════════════════════════════════════╗"
echo "║  Ralph reached max iterations without completing      ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo "Max iterations: $MAX_ITERATIONS"
echo "Check $PROGRESS_FILE for status."
exit 1
