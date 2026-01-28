#!/usr/bin/env bash
set -euo pipefail

JEEVES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || (cd "$JEEVES_DIR/../.." && pwd))"
JEEVES_SH="$JEEVES_DIR/jeeves.sh"
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

assert_file_not_exists() {
  local path="$1"
  if [[ -e "$path" ]]; then
    fail "Expected file to NOT exist: $path"
  fi
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
  "project": "Jeeves Test Project",
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

write_issue_config_with_tasks() {
  local state_dir="$1"
  local task_stage="${2:-implement}"
  local tasks_complete="${3:-false}"
  local design_doc_path="${4-docs/design-document-template.md}"
  mkdir -p "$state_dir"
  cat > "$state_dir/issue.json" <<JSON
{
  "project": "Jeeves Test Project",
  "branchName": "issue/1-test-branch",
  "issue": {
    "number": 1,
    "repo": "example/repo"
  },
  "designDocPath": "$design_doc_path",
  "tasks": [
    {
      "id": "T1",
      "title": "Task one",
      "summary": "First task",
      "acceptanceCriteria": ["AC1"],
      "status": "pending"
    }
  ],
  "status": {
    "implemented": true,
    "prCreated": true,
    "prDescriptionReady": true,
    "taskStage": "$task_stage",
    "currentTaskId": "T1",
    "tasksComplete": $tasks_complete,
    "reviewClean": false,
    "reviewPasses": 0,
    "reviewCleanPasses": 0,
    "ciClean": false,
    "ciPasses": 0,
    "coverageClean": false,
    "coverageNeedsFix": false,
    "coveragePasses": 0,
    "sonarClean": false
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

if [[ -n "${CODEX_STUB_TOUCH_FILE:-}" ]]; then
  mkdir -p "$(dirname "$CODEX_STUB_TOUCH_FILE")" 2>/dev/null || true
  : > "$CODEX_STUB_TOUCH_FILE"
fi

if [[ -n "$last_message" ]]; then
  echo "<promise>COMPLETE</promise>" > "$last_message"
fi
echo "<promise>COMPLETE</promise>"
BASH

  chmod +x "$stub_dir/codex"
}

run_jeeves() {
  local state_dir="$1"
  local stub_dir="$2"
  local args_file="$3"

  shift 3
  local extra_env=("$@")

  (
    cd "${RUN_DIR:?}"
    env \
      PATH="$stub_dir:$PATH" \
      CODEX_STUB_ARGS_FILE="$args_file" \
      JEEVES_RUNNER="codex" \
      JEEVES_MODE="issue" \
      JEEVES_STATE_DIR="$state_dir" \
      "${extra_env[@]}" \
      bash "$JEEVES_SH" 1
  )
}

test_codex_exec_dangerous_bypass() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-dangerous"
  local stub_dir="$tmp_root/bin-dangerous"
  local args_file="$tmp_root/args-dangerous.txt"

  write_issue_config "$state_dir"
  write_codex_stub "$stub_dir"

  set +e
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_OUTPUT_MODE="stream" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-dangerous.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-dangerous.txt" >&2
    fail "jeeves.sh exited non-zero in dangerous mode: $status"
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

  write_issue_config "$state_dir"
  write_codex_stub "$stub_dir"

  set +e
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="0" \
    JEEVES_CODEX_SANDBOX="workspace-write" \
    CODEX_STUB_MODE="landlock-then-complete" \
    CODEX_STUB_CALL_COUNT_FILE="$call_count_file" \
    >"$tmp_root/out-landlock.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-landlock.txt" >&2
    fail "jeeves.sh exited non-zero in landlock retry test: $status"
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

  write_issue_config "$state_dir"
  write_codex_stub "$stub_dir"

  echo "EXTRA PROMPT INSTRUCTIONS" > "$append_file"

  set +e
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    JEEVES_PROMPT_APPEND_FILE="$append_file" \
    CODEX_STUB_STDIN_FILE="$stdin_file" \
    >"$tmp_root/out-prompt-append.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-prompt-append.txt" >&2
    fail "jeeves.sh exited non-zero in prompt append test: $status"
  fi

  assert_file_exists "$stdin_file"
  local stdin_content
  stdin_content="$(cat "$stdin_file")"

  assert_contains "$stdin_content" "Jeeves Agent Instructions"
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
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-questions.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-questions.txt" >&2
    fail "jeeves.sh exited non-zero in open questions test: $status"
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
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-missing-design-doc.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-missing-design-doc.txt" >&2
    fail "jeeves.sh exited non-zero in missing design doc phase selection test: $status"
  fi

  local output
  output="$(cat "$tmp_root/out-missing-design-doc.txt")"
  assert_contains "$output" "[DEBUG] Phase: design"
  assert_contains "$output" "prompt.issue.design.md"
}

test_issue_tasks_select_task_implement_prompt() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-task-implement"
  local stub_dir="$tmp_root/bin-task-implement"
  local args_file="$tmp_root/args-task-implement.txt"

  write_issue_config_with_tasks "$state_dir" "implement" "false"
  write_codex_stub "$stub_dir"

  set +e
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-task-implement.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-task-implement.txt" >&2
    fail "jeeves.sh exited non-zero in task implement phase selection test: $status"
  fi

  local output
  output="$(cat "$tmp_root/out-task-implement.txt")"
  assert_contains "$output" "[DEBUG] Phase: task-implement"
  assert_contains "$output" "prompt.issue.task.implement.md"
}

test_issue_tasks_select_task_spec_review_prompt() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-task-spec-review"
  local stub_dir="$tmp_root/bin-task-spec-review"
  local args_file="$tmp_root/args-task-spec-review.txt"

  write_issue_config_with_tasks "$state_dir" "spec-review" "false"
  write_codex_stub "$stub_dir"

  set +e
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-task-spec-review.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-task-spec-review.txt" >&2
    fail "jeeves.sh exited non-zero in task spec review phase selection test: $status"
  fi

  local output
  output="$(cat "$tmp_root/out-task-spec-review.txt")"
  assert_contains "$output" "[DEBUG] Phase: task-spec-review"
  assert_contains "$output" "prompt.issue.task.spec-review.md"
}

test_issue_tasks_select_task_quality_review_prompt() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-task-quality-review"
  local stub_dir="$tmp_root/bin-task-quality-review"
  local args_file="$tmp_root/args-task-quality-review.txt"

  write_issue_config_with_tasks "$state_dir" "quality-review" "false"
  write_codex_stub "$stub_dir"

  set +e
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-task-quality-review.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-task-quality-review.txt" >&2
    fail "jeeves.sh exited non-zero in task quality review phase selection test: $status"
  fi

  local output
  output="$(cat "$tmp_root/out-task-quality-review.txt")"
  assert_contains "$output" "[DEBUG] Phase: task-quality-review"
  assert_contains "$output" "prompt.issue.task.quality-review.md"
}

test_issue_pr_description_not_ready_selects_implement_prompt() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-pr-description-not-ready"
  local stub_dir="$tmp_root/bin-pr-description-not-ready"
  local args_file="$tmp_root/args-pr-description-not-ready.txt"

  write_issue_config "$state_dir" "false"
  write_codex_stub "$stub_dir"

  set +e
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-pr-description-not-ready.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-pr-description-not-ready.txt" >&2
    fail "jeeves.sh exited non-zero in pr description gating test: $status"
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
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-pr-description-ready.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-pr-description-ready.txt" >&2
    fail "jeeves.sh exited non-zero in pr description ready test: $status"
  fi

  local output
  output="$(cat "$tmp_root/out-pr-description-ready.txt")"
  assert_contains "$output" "[DEBUG] Phase: review"
  assert_contains "$output" "prompt.issue.review.md"
}

test_issue_review_clean_selects_coverage_prompt() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-review-clean"
  local stub_dir="$tmp_root/bin-review-clean"
  local args_file="$tmp_root/args-review-clean.txt"

  write_issue_config "$state_dir" "true" "true" "false" "false" "false" "false"
  write_codex_stub "$stub_dir"

  set +e
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-review-clean.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-review-clean.txt" >&2
    fail "jeeves.sh exited non-zero in coverage phase selection test: $status"
  fi

  local output
  output="$(cat "$tmp_root/out-review-clean.txt")"
  assert_contains "$output" "[DEBUG] Phase: coverage"
  assert_contains "$output" "prompt.issue.coverage.md"
}

test_issue_sonar_clean_selects_ci_prompt() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-sonar-clean-selects-ci"
  local stub_dir="$tmp_root/bin-sonar-clean-selects-ci"
  local args_file="$tmp_root/args-sonar-clean-selects-ci.txt"

  write_issue_config "$state_dir" "true" "true" "false" "true" "false" "true"
  write_codex_stub "$stub_dir"

  set +e
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-ci-clean.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-ci-clean.txt" >&2
    fail "jeeves.sh exited non-zero in coverage phase selection test: $status"
  fi

  local output
  output="$(cat "$tmp_root/out-ci-clean.txt")"
  assert_contains "$output" "[DEBUG] Phase: ci"
  assert_contains "$output" "prompt.issue.ci.md"
}

test_issue_coverage_needs_fix_selects_coverage_fix_prompt() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-coverage-needs-fix"
  local stub_dir="$tmp_root/bin-coverage-needs-fix"
  local args_file="$tmp_root/args-coverage-needs-fix.txt"

  write_issue_config "$state_dir" "true" "true" "true" "false" "true" "false"
  write_codex_stub "$stub_dir"

  set +e
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-coverage-needs-fix.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-coverage-needs-fix.txt" >&2
    fail "jeeves.sh exited non-zero in coverage fix phase selection test: $status"
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
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-coverage-failures-file.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-coverage-failures-file.txt" >&2
    fail "jeeves.sh exited non-zero in coverage failures file phase selection test: $status"
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

  write_issue_config "$state_dir" "true" "true" "false" "true" "false" "false"
  write_codex_stub "$stub_dir"

  set +e
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-coverage-clean.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-coverage-clean.txt" >&2
    fail "jeeves.sh exited non-zero in sonar phase selection test: $status"
  fi

  local output
  output="$(cat "$tmp_root/out-coverage-clean.txt")"
  assert_contains "$output" "[DEBUG] Phase: sonar"
  assert_contains "$output" "prompt.issue.sonar.md"
}

test_metrics_are_written_by_default() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-metrics-default"
  local stub_dir="$tmp_root/bin-metrics-default"
  local args_file="$tmp_root/args-metrics-default.txt"

  write_issue_config "$state_dir"
  write_codex_stub "$stub_dir"

  set +e
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-metrics-default.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-metrics-default.txt" >&2
    fail "jeeves.sh exited non-zero in metrics default test: $status"
  fi

  local metrics_file="$state_dir/metrics.jsonl"
  assert_file_exists "$metrics_file"

  local current_run_file="$state_dir/current-run.json"
  assert_file_exists "$current_run_file"
  local run_id run_dir
  run_id="$(jq -r '.runId // empty' "$current_run_file" 2>/dev/null || echo "")"
  if [[ -z "$run_id" || "$run_id" == "null" ]]; then
    fail "Expected current-run.json to include runId"
  fi
  run_dir="$state_dir/.runs/$run_id"
  assert_file_exists "$run_dir/run.json"
  assert_file_exists "$run_dir/metrics.jsonl"
  assert_file_exists "$run_dir/iterations/iter-1.last-run.log"
  assert_file_exists "$run_dir/iterations/iter-1.last-message.txt"

  local metrics
  metrics="$(cat "$metrics_file")"
  assert_contains "$metrics" "\"event\":\"run_start\""
  assert_contains "$metrics" "\"event\":\"iteration_start\""
  assert_contains "$metrics" "\"event\":\"iteration_end\""
  assert_contains "$metrics" "\"event\":\"run_end\""
  assert_contains "$metrics" "\"completionReason\":\"promise\""
  assert_contains "$metrics" "\"reason\":\"complete_promise\""

  local run_metrics
  run_metrics="$(cat "$run_dir/metrics.jsonl")"
  assert_contains "$run_metrics" "\"event\":\"run_start\""
  assert_contains "$run_metrics" "\"event\":\"run_end\""
}

test_metrics_iteration_end_phase_matches_start_phase() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-metrics-phase"
  local stub_dir="$tmp_root/bin-metrics-phase"
  local args_file="$tmp_root/args-metrics-phase.txt"
  local design_doc="$tmp_root/design-doc-generated.md"

  # Start in the "design" phase by pointing at a missing design doc,
  # then simulate the agent creating it so the selected phase changes after the run.
  write_issue_config "$state_dir" "true" "false" "false" "false" "false" "false" "$design_doc"
  write_codex_stub "$stub_dir"

  set +e
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    CODEX_STUB_TOUCH_FILE="$design_doc" \
    >"$tmp_root/out-metrics-phase.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-metrics-phase.txt" >&2
    fail "jeeves.sh exited non-zero in metrics phase attribution test: $status"
  fi

  local metrics_file="$state_dir/metrics.jsonl"
  assert_file_exists "$metrics_file"

  local start_phase end_phase
  start_phase="$(jq -r 'select(.event=="iteration_start") | .phase' "$metrics_file" | head -n 1)"
  end_phase="$(jq -r 'select(.event=="iteration_end") | .phase' "$metrics_file" | head -n 1)"

  if [[ "$start_phase" != "design" ]]; then
    fail "Expected iteration_start phase to be design, got: $start_phase"
  fi

  if [[ "$end_phase" != "$start_phase" ]]; then
    fail "Expected iteration_end phase to match iteration_start (ran=$start_phase), got: $end_phase"
  fi
}

test_metrics_can_be_disabled() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-metrics-disabled"
  local stub_dir="$tmp_root/bin-metrics-disabled"
  local args_file="$tmp_root/args-metrics-disabled.txt"

  write_issue_config "$state_dir"
  write_codex_stub "$stub_dir"

  set +e
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_METRICS="0" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-metrics-disabled.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-metrics-disabled.txt" >&2
    fail "jeeves.sh exited non-zero in metrics disabled test: $status"
  fi

  assert_file_not_exists "$state_dir/metrics.jsonl"
}

test_debug_logs_are_written_per_phase() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-debug-phase"
  local stub_dir="$tmp_root/bin-debug-phase"
  local args_file="$tmp_root/args-debug-phase.txt"

  write_issue_config "$state_dir"
  write_codex_stub "$stub_dir"

  set +e
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-debug-phase.txt" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-debug-phase.txt" >&2
    fail "jeeves.sh exited non-zero in debug log test: $status"
  fi

  local run_id run_dir
  run_id="$(jq -r '.runId // empty' "$state_dir/current-run.json" 2>/dev/null || echo "")"
  if [[ -z "$run_id" || "$run_id" == "null" ]]; then
    fail "Expected current-run.json to include runId for debug log test"
  fi
  run_dir="$state_dir/.runs/$run_id"

  local debug_file="$run_dir/debug-review.jsonl"
  assert_file_exists "$debug_file"

  local debug_content
  debug_content="$(cat "$debug_file")"
  assert_contains "$debug_content" "\"event\":\"debug_run_start\""
  assert_contains "$debug_content" "\"event\":\"debug_iteration_start\""
  assert_contains "$debug_content" "\"event\":\"debug_iteration_end\""

  local seq_check
  seq_check="$(jq -r '.seq' "$debug_file" | awk 'NR==1{prev=$1;next} {if($1<prev){exit 1} prev=$1} END{if(NR==0) exit 1}')"
  if [[ $? -ne 0 ]]; then
    fail "Expected debug seq values to be monotonic in $debug_file"
  fi

  local run_index="$run_dir/run-index.json"
  assert_file_exists "$run_index"
  jq -e 'any(.files[]; .phase=="review")' "$run_index" >/dev/null 2>&1 || fail "run-index.json missing review phase entry"
}

test_run_artifacts_are_separated_per_invocation() {
  local tmp_root="$1"
  local state_dir="$tmp_root/state-run-artifacts"
  local stub_dir="$tmp_root/bin-run-artifacts"
  local args_file="$tmp_root/args-run-artifacts.txt"

  write_issue_config "$state_dir"
  write_codex_stub "$stub_dir"

  set +e
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-run-artifacts-1.txt" 2>&1
  local status=$?
  set -e
  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-run-artifacts-1.txt" >&2
    fail "jeeves.sh exited non-zero in run artifacts test (first run): $status"
  fi

  local run_id_1
  run_id_1="$(jq -r '.runId // empty' "$state_dir/current-run.json" 2>/dev/null || echo "")"
  if [[ -z "$run_id_1" || "$run_id_1" == "null" ]]; then
    fail "Expected current-run.json to include runId after first run"
  fi

  set +e
  run_jeeves "$state_dir" "$stub_dir" "$args_file" \
    JEEVES_CODEX_APPROVAL_POLICY="never" \
    JEEVES_CODEX_DANGEROUS="1" \
    >"$tmp_root/out-run-artifacts-2.txt" 2>&1
  status=$?
  set -e
  if [[ $status -ne 0 ]]; then
    cat "$tmp_root/out-run-artifacts-2.txt" >&2
    fail "jeeves.sh exited non-zero in run artifacts test (second run): $status"
  fi

  local run_id_2
  run_id_2="$(jq -r '.runId // empty' "$state_dir/current-run.json" 2>/dev/null || echo "")"
  if [[ -z "$run_id_2" || "$run_id_2" == "null" ]]; then
    fail "Expected current-run.json to include runId after second run"
  fi

  if [[ "$run_id_1" == "$run_id_2" ]]; then
    fail "Expected run IDs to differ across runs, got: $run_id_1"
  fi

  assert_file_exists "$state_dir/.runs/$run_id_1/run.json"
  assert_file_exists "$state_dir/.runs/$run_id_2/run.json"
  assert_file_exists "$state_dir/.runs/$run_id_1/metrics.jsonl"
  assert_file_exists "$state_dir/.runs/$run_id_2/metrics.jsonl"
}

main() {
  if [[ ! -f "$JEEVES_SH" ]]; then
    fail "jeeves.sh not found at: $JEEVES_SH"
  fi

  TMP_ROOT="$(mktemp -d)"
  mkdir -p "$REPO_ROOT/.cache"
  RUN_DIR="$(mktemp -d "$REPO_ROOT/.cache/jeeves-test-run.XXXXXX")"
  trap 'rm -rf "$TMP_ROOT" "$RUN_DIR"' EXIT

  test_codex_exec_dangerous_bypass "$TMP_ROOT"
  test_codex_exec_sandbox_landlock_retry "$TMP_ROOT"
  test_prompt_append_file_is_included_in_stdin "$TMP_ROOT"
  test_issue_open_questions_selects_questions_prompt "$TMP_ROOT"
  test_issue_missing_design_doc_selects_design_prompt "$TMP_ROOT"
  test_issue_tasks_select_task_implement_prompt "$TMP_ROOT"
  test_issue_tasks_select_task_spec_review_prompt "$TMP_ROOT"
  test_issue_tasks_select_task_quality_review_prompt "$TMP_ROOT"
  test_issue_pr_description_not_ready_selects_implement_prompt "$TMP_ROOT"
  test_issue_pr_description_ready_selects_review_prompt "$TMP_ROOT"
  test_issue_review_clean_selects_coverage_prompt "$TMP_ROOT"
  test_issue_sonar_clean_selects_ci_prompt "$TMP_ROOT"
  test_issue_coverage_needs_fix_selects_coverage_fix_prompt "$TMP_ROOT"
  test_issue_coverage_failures_file_selects_coverage_fix_prompt "$TMP_ROOT"
  test_issue_coverage_clean_selects_sonar_prompt "$TMP_ROOT"
  test_metrics_are_written_by_default "$TMP_ROOT"
  test_metrics_iteration_end_phase_matches_start_phase "$TMP_ROOT"
  test_metrics_can_be_disabled "$TMP_ROOT"
  test_debug_logs_are_written_per_phase "$TMP_ROOT"
  test_run_artifacts_are_separated_per_invocation "$TMP_ROOT"

  echo "[OK] Jeeves exec tests passed"
}

main "$@"
