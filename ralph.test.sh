#!/usr/bin/env bash
set -euo pipefail

RALPH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || (cd "$RALPH_DIR/../.." && pwd))"
RALPH_SH="$RALPH_DIR/ralph.sh"
RUN_DIR=""
TMP_ROOT=""

fail() {
  echo "[FAIL] $*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  if [[ "$haystack" != *"$needle"* ]]; then
    fail "Expected output to contain: $needle
--- output ---
$haystack
--- end ---"
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  if [[ "$haystack" == *"$needle"* ]]; then
    fail "Expected output NOT to contain: $needle
--- output ---
$haystack
--- end ---"
  fi
}

assert_file_exists() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    fail "Expected file to exist: $path"
  fi
}

write_prd_config() {
  local state_dir="$1"
  mkdir -p "$state_dir"
  cat > "$state_dir/prd.json" <<'JSON'
{
  "branchName": "ralph/test",
  "userStories": [
    {
      "id": "1",
      "title": "Test story",
      "passes": false
    }
  ]
}
JSON
}

write_issue_config() {
  local state_dir="$1"
  local pr_description_ready="${2:-true}"
  local review_clean="${3:-false}"
  local ci_clean="${4:-false}"
  local coverage_clean="${5:-false}"
  local coverage_needs_fix="${6:-false}"
  local sonar_clean="${7:-false}"
  local design_doc_path="${8-docs/design-document-template.md}"
  mkdir -p "$state_dir"
  cat > "$state_dir/issue.json" <<JSON
{
  "project": "Ralph Test Project",
  "branchName": "issue/1-test-branch",
  "issue": {
    "number": 1,
    "repo": "example/repo"
  },
  "designDocPath": "$design_doc_path",
  "status": {
    "implemented": true,
    "prCreated": true,
    "prDescriptionReady": $pr_description_ready,
    "reviewClean": $review_clean,
    "reviewPasses": 0,
    "reviewCleanPasses": 0,
    "ciClean": $ci_clean,
    "ciPasses": 0,
    "coverageClean": $coverage_clean,
    "coverageNeedsFix": $coverage_needs_fix,
    "coveragePasses": 0,
    "sonarClean": $sonar_clean
  },
  "pullRequest": {
    "number": 1,
    "url": "https://example.com/pr/1"
  },
  "notes": ""
}
JSON
}

write_codex_stub() {
  local stub_dir="$1"
  mkdir -p "$stub_dir"

  cat > "$stub_dir/codex" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

args=("$@")
printf '%s\n' "${args[*]}" >> "${CODEX_STUB_ARGS_FILE:?}"

if [[ -n "${CODEX_STUB_STDIN_FILE:-}" ]]; then
  cat - > "${CODEX_STUB_STDIN_FILE}"
fi

call_count=1
if [[ -n "${CODEX_STUB_CALL_COUNT_FILE:-}" ]]; then
  if [[ -f "$CODEX_STUB_CALL_COUNT_FILE" ]]; then
    call_count="$(($(cat "$CODEX_STUB_CALL_COUNT_FILE") + 1))"
  fi
  echo "$call_count" > "$CODEX_STUB_CALL_COUNT_FILE"
fi

last_message=""
for ((i=0; i<${#args[@]}; i++)); do
  if [[ "${args[$i]}" == "--output-last-message" || "${args[$i]}" == "-o" ]]; then
    last_message="${args[$((i+1))]:-}"
  fi
done

mode="${CODEX_STUB_MODE:-complete}"
if [[ "$mode" == "landlock-then-complete" && "$call_count" -eq 1 ]]; then
  echo "error running landlock: Sandbox(LandlockRestrict)"
  exit 0
fi

if [[ -n "$last_message" ]]; then
  echo "<promise>COMPLETE</promise>" > "$last_message"
fi
echo "<promise>COMPLETE</promise>"
BASH

  chmod +x "$stub_dir/codex"
}

run_ralph() {
  local mode="$1"
  local state_dir="$2"
  local stub_dir="$3"
  local args_file="$4"

  shift 4
  local extra_env=("$@")

  (
    cd "${RUN_DIR:?}"
    env \
      PATH="$stub_dir:$PATH" \
      CODEX_STUB_ARGS_FILE="$args_file" \
      RALPH_RUNNER="codex" \
      RALPH_MODE="$mode" \
      RALPH_STATE_DIR="$state_dir" \
      "${extra_env[@]}" \
      bash "$RALPH_SH" 1
  )
}

test_codex_exec_dangerous_bypass() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-dangerous"
  local stub_dir="$tmp_root/bin-dangerous"
  local args_file="$tmp_root/args-dangerous.txt"

  write_prd_config "$state_dir"
  write_codex_stub "$stub_dir"

  set +e
  run_ralph "prd" "$state_dir" "$stub_dir" "$args_file" \
    RALPH_OUTPUT_MODE="stream" \
    RALPH_CODEX_APPROVAL_POLICY="never" \
    RALPH_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-dangerous.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-dangerous.txt" >&2
    fail "ralph.sh exited non-zero in dangerous mode: $status"
  fi

  assert_file_exists "$args_file"
  local args
  args="$(cat "$args_file")"

  assert_contains "$args" "--ask-for-approval never"
  assert_contains "$args" "exec --dangerously-bypass-approvals-and-sandbox"
  assert_contains "$args" "-C $REPO_ROOT --color"
  assert_contains "$args" "--color never"
  assert_contains "$args" "--output-last-message $state_dir/last-message.txt"
  assert_contains "$args" " -"
  assert_not_contains "$args" " --sandbox "
}

test_codex_exec_sandbox_landlock_retry() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-landlock"
  local stub_dir="$tmp_root/bin-landlock"
  local args_file="$tmp_root/args-landlock.txt"
  local call_count_file="$tmp_root/landlock-call-count.txt"

  write_prd_config "$state_dir"
  write_codex_stub "$stub_dir"

  set +e
  run_ralph "prd" "$state_dir" "$stub_dir" "$args_file" \
    RALPH_CODEX_APPROVAL_POLICY="never" \
    RALPH_CODEX_DANGEROUS="0" \
    RALPH_CODEX_SANDBOX="workspace-write" \
    CODEX_STUB_MODE="landlock-then-complete" \
    CODEX_STUB_CALL_COUNT_FILE="$call_count_file" \
    >"$tmp_root/out-landlock.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-landlock.txt" >&2
    fail "ralph.sh exited non-zero in landlock retry test: $status"
  fi

  assert_file_exists "$args_file"
  local call1 call2
  call1="$(sed -n '1p' "$args_file")"
  call2="$(sed -n '2p' "$args_file")"

  if [[ -z "$call2" ]]; then
    cat "$tmp_root/out-landlock.txt" >&2
    fail "Expected 2 codex invocations (sandbox then fallback), but saw 1"
  fi

  assert_contains "$call1" "exec --sandbox workspace-write"
  assert_not_contains "$call1" "--dangerously-bypass-approvals-and-sandbox"

  assert_contains "$call2" "exec --dangerously-bypass-approvals-and-sandbox"
  assert_not_contains "$call2" " --sandbox "
}

test_prompt_append_file_is_included_in_stdin() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-prompt-append"
  local stub_dir="$tmp_root/bin-prompt-append"
  local args_file="$tmp_root/args-prompt-append.txt"
  local stdin_file="$tmp_root/stdin-prompt-append.txt"
  local append_file="$tmp_root/prompt-append.md"

  write_prd_config "$state_dir"
  write_codex_stub "$stub_dir"

  echo "EXTRA PROMPT INSTRUCTIONS" > "$append_file"

  set +e
  run_ralph "prd" "$state_dir" "$stub_dir" "$args_file" \
    RALPH_CODEX_APPROVAL_POLICY="never" \
    RALPH_CODEX_DANGEROUS="1" \
    RALPH_PROMPT_APPEND_FILE="$append_file" \
    CODEX_STUB_STDIN_FILE="$stdin_file" \
    >"$tmp_root/out-prompt-append.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-prompt-append.txt" >&2
    fail "ralph.sh exited non-zero in prompt append test: $status"
  fi

  assert_file_exists "$stdin_file"
  local stdin_content
  stdin_content="$(cat "$stdin_file")"

  assert_contains "$stdin_content" "Ralph Agent Instructions"
  assert_contains "$stdin_content" "EXTRA PROMPT INSTRUCTIONS"
}

test_issue_open_questions_selects_questions_prompt() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-questions"
  local stub_dir="$tmp_root/bin-questions"
  local args_file="$tmp_root/args-questions.txt"

  write_issue_config "$state_dir"
  echo "- What does this code path do?" > "$state_dir/open-questions.md"
  write_codex_stub "$stub_dir"

  set +e
  run_ralph "issue" "$state_dir" "$stub_dir" "$args_file" \
    RALPH_CODEX_APPROVAL_POLICY="never" \
    RALPH_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-questions.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-questions.txt" >&2
    fail "ralph.sh exited non-zero in open questions test: $status"
  fi

  local output
  output="$(cat "$tmp_root/out-questions.txt")"
  assert_contains "$output" "[DEBUG] Phase: questions"
  assert_contains "$output" "prompt.issue.questions.md"
}

test_issue_missing_design_doc_selects_design_prompt() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-missing-design-doc"
  local stub_dir="$tmp_root/bin-missing-design-doc"
  local args_file="$tmp_root/args-missing-design-doc.txt"

  write_issue_config "$state_dir" "true" "false" "false" "false" "false" "false" ""
  write_codex_stub "$stub_dir"

  set +e
  run_ralph "issue" "$state_dir" "$stub_dir" "$args_file" \
    RALPH_CODEX_APPROVAL_POLICY="never" \
    RALPH_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-missing-design-doc.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-missing-design-doc.txt" >&2
    fail "ralph.sh exited non-zero in missing design doc phase selection test: $status"
  fi

  local output
  output="$(cat "$tmp_root/out-missing-design-doc.txt")"
  assert_contains "$output" "[DEBUG] Phase: design"
  assert_contains "$output" "prompt.issue.design.md"
}

test_issue_pr_description_not_ready_selects_implement_prompt() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-pr-description-not-ready"
  local stub_dir="$tmp_root/bin-pr-description-not-ready"
  local args_file="$tmp_root/args-pr-description-not-ready.txt"

  write_issue_config "$state_dir" "false"
  write_codex_stub "$stub_dir"

  set +e
  run_ralph "issue" "$state_dir" "$stub_dir" "$args_file" \
    RALPH_CODEX_APPROVAL_POLICY="never" \
    RALPH_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-pr-description-not-ready.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-pr-description-not-ready.txt" >&2
    fail "ralph.sh exited non-zero in pr description gating test: $status"
  fi

  local output
  output="$(cat "$tmp_root/out-pr-description-not-ready.txt")"
  assert_contains "$output" "[DEBUG] Phase: implement"
  assert_contains "$output" "prompt.issue.implement.md"
}

test_issue_pr_description_ready_selects_review_prompt() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-pr-description-ready"
  local stub_dir="$tmp_root/bin-pr-description-ready"
  local args_file="$tmp_root/args-pr-description-ready.txt"

  write_issue_config "$state_dir" "true" "false"
  write_codex_stub "$stub_dir"

  set +e
  run_ralph "issue" "$state_dir" "$stub_dir" "$args_file" \
    RALPH_CODEX_APPROVAL_POLICY="never" \
    RALPH_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-pr-description-ready.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-pr-description-ready.txt" >&2
    fail "ralph.sh exited non-zero in pr description ready test: $status"
  fi

  local output
  output="$(cat "$tmp_root/out-pr-description-ready.txt")"
  assert_contains "$output" "[DEBUG] Phase: review"
  assert_contains "$output" "prompt.issue.review.md"
}

test_issue_review_clean_selects_ci_prompt() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-review-clean"
  local stub_dir="$tmp_root/bin-review-clean"
  local args_file="$tmp_root/args-review-clean.txt"

  write_issue_config "$state_dir" "true" "true" "false" "false" "false" "false"
  write_codex_stub "$stub_dir"

  set +e
  run_ralph "issue" "$state_dir" "$stub_dir" "$args_file" \
    RALPH_CODEX_APPROVAL_POLICY="never" \
    RALPH_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-review-clean.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-review-clean.txt" >&2
    fail "ralph.sh exited non-zero in coverage phase selection test: $status"
  fi

  local output
  output="$(cat "$tmp_root/out-review-clean.txt")"
  assert_contains "$output" "[DEBUG] Phase: ci"
  assert_contains "$output" "prompt.issue.ci.md"
}

test_issue_ci_clean_selects_coverage_prompt() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-ci-clean"
  local stub_dir="$tmp_root/bin-ci-clean"
  local args_file="$tmp_root/args-ci-clean.txt"

  write_issue_config "$state_dir" "true" "true" "true" "false" "false" "false"
  write_codex_stub "$stub_dir"

  set +e
  run_ralph "issue" "$state_dir" "$stub_dir" "$args_file" \
    RALPH_CODEX_APPROVAL_POLICY="never" \
    RALPH_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-ci-clean.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-ci-clean.txt" >&2
    fail "ralph.sh exited non-zero in coverage phase selection test: $status"
  fi

  local output
  output="$(cat "$tmp_root/out-ci-clean.txt")"
  assert_contains "$output" "[DEBUG] Phase: coverage"
  assert_contains "$output" "prompt.issue.coverage.md"
}

test_issue_coverage_needs_fix_selects_coverage_fix_prompt() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-coverage-needs-fix"
  local stub_dir="$tmp_root/bin-coverage-needs-fix"
  local args_file="$tmp_root/args-coverage-needs-fix.txt"

  write_issue_config "$state_dir" "true" "true" "true" "false" "true" "false"
  write_codex_stub "$stub_dir"

  set +e
  run_ralph "issue" "$state_dir" "$stub_dir" "$args_file" \
    RALPH_CODEX_APPROVAL_POLICY="never" \
    RALPH_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-coverage-needs-fix.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-coverage-needs-fix.txt" >&2
    fail "ralph.sh exited non-zero in coverage fix phase selection test: $status"
  fi

  local output
  output="$(cat "$tmp_root/out-coverage-needs-fix.txt")"
  assert_contains "$output" "[DEBUG] Phase: coverage-fix"
  assert_contains "$output" "prompt.issue.coverage.fix.md"
}

test_issue_coverage_failures_file_selects_coverage_fix_prompt() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-coverage-failures-file"
  local stub_dir="$tmp_root/bin-coverage-failures-file"
  local args_file="$tmp_root/args-coverage-failures-file.txt"

  write_issue_config "$state_dir" "true" "true" "true" "false" "false" "false"
  echo "Failing test: should handle edge case X" > "$state_dir/coverage-failures.md"
  write_codex_stub "$stub_dir"

  set +e
  run_ralph "issue" "$state_dir" "$stub_dir" "$args_file" \
    RALPH_CODEX_APPROVAL_POLICY="never" \
    RALPH_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-coverage-failures-file.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-coverage-failures-file.txt" >&2
    fail "ralph.sh exited non-zero in coverage failures file phase selection test: $status"
  fi

  local output
  output="$(cat "$tmp_root/out-coverage-failures-file.txt")"
  assert_contains "$output" "[DEBUG] Phase: coverage-fix"
  assert_contains "$output" "prompt.issue.coverage.fix.md"
}

test_issue_coverage_clean_selects_sonar_prompt() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-coverage-clean"
  local stub_dir="$tmp_root/bin-coverage-clean"
  local args_file="$tmp_root/args-coverage-clean.txt"

  write_issue_config "$state_dir" "true" "true" "true" "true" "false" "false"
  write_codex_stub "$stub_dir"

  set +e
  run_ralph "issue" "$state_dir" "$stub_dir" "$args_file" \
    RALPH_CODEX_APPROVAL_POLICY="never" \
    RALPH_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-coverage-clean.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-coverage-clean.txt" >&2
    fail "ralph.sh exited non-zero in sonar phase selection test: $status"
  fi

  local output
  output="$(cat "$tmp_root/out-coverage-clean.txt")"
  assert_contains "$output" "[DEBUG] Phase: sonar"
  assert_contains "$output" "prompt.issue.sonar.md"
}

main() {
  if [[ ! -f "$RALPH_SH" ]]; then
    fail "ralph.sh not found at: $RALPH_SH"
  fi

  TMP_ROOT="$(mktemp -d)"
  mkdir -p "$REPO_ROOT/.cache"
  RUN_DIR="$(mktemp -d "$REPO_ROOT/.cache/ralph-test-run.XXXXXX")"
  trap 'rm -rf "$TMP_ROOT" "$RUN_DIR"' EXIT

  test_codex_exec_dangerous_bypass "$TMP_ROOT"
  test_codex_exec_sandbox_landlock_retry "$TMP_ROOT"
  test_prompt_append_file_is_included_in_stdin "$TMP_ROOT"
  test_issue_open_questions_selects_questions_prompt "$TMP_ROOT"
  test_issue_missing_design_doc_selects_design_prompt "$TMP_ROOT"
  test_issue_pr_description_not_ready_selects_implement_prompt "$TMP_ROOT"
  test_issue_pr_description_ready_selects_review_prompt "$TMP_ROOT"
  test_issue_review_clean_selects_ci_prompt "$TMP_ROOT"
  test_issue_ci_clean_selects_coverage_prompt "$TMP_ROOT"
  test_issue_coverage_needs_fix_selects_coverage_fix_prompt "$TMP_ROOT"
  test_issue_coverage_failures_file_selects_coverage_fix_prompt "$TMP_ROOT"
  test_issue_coverage_clean_selects_sonar_prompt "$TMP_ROOT"

  echo "[OK] Ralph exec tests passed"
}

main "$@"
