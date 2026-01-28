#!/bin/bash
# Jeeves Wiggum - Long-running AI agent loop
# Usage: ./jeeves.sh [--runner sdk|codex|claude] [--codex|--claude] [--max-iterations N] [max_iterations]

set -e

cleanup_tmp_prompt() {
  if [ -n "${TMP_PROMPT_FILE:-}" ] && [ -f "${TMP_PROMPT_FILE:-}" ]; then
    rm -f "$TMP_PROMPT_FILE" 2>/dev/null || true
  fi
}

metrics_is_enabled() {
  local value="${1:-1}"
  case "$value" in
    0|""|[Ff][Aa][Ll][Ss][Ee]|[Nn][Oo]) return 1 ;;
    *) return 0 ;;
  esac
}

metrics_append_json() {
  local json_line="${1:-}"
  if [ -z "$json_line" ]; then
    return 0
  fi

  local primary_file="${METRICS_FILE:-}"
  local run_file="${RUN_METRICS_FILE:-}"

  if [ -n "$primary_file" ]; then
    mkdir -p "$(dirname "$primary_file")" 2>/dev/null || true
    printf '%s\n' "$json_line" >> "$primary_file" 2>/dev/null || true
  fi

  if [ -n "$run_file" ] && [ "$run_file" != "$primary_file" ]; then
    mkdir -p "$(dirname "$run_file")" 2>/dev/null || true
    printf '%s\n' "$json_line" >> "$run_file" 2>/dev/null || true
  fi
}

debug_is_enabled() {
  local value="${1:-1}"
  case "$value" in
    0|""|[Ff][Aa][Ll][Ss][Ee]|[Nn][Oo]) return 1 ;;
    *) return 0 ;;
  esac
}

debug_trace_is_full() {
  local value="${1:-full}"
  case "$value" in
    ""|[Ff][Uu][Ll][Ll]) return 0 ;;
    *) return 1 ;;
  esac
}

debug_next_seq() {
  DEBUG_SEQ=$((DEBUG_SEQ + 1))
  echo "$DEBUG_SEQ"
}

debug_phase_key() {
  local phase="${1:-}"
  if [ -n "$phase" ]; then
    echo "$phase"
  else
    echo "${ISSUE_PHASE:-unknown}"
  fi
}

debug_phase_file() {
  local phase="$1"
  local safe_phase
  safe_phase="${phase//\//-}"
  safe_phase="${safe_phase// /-}"
  echo "${RUN_DIR:-}/debug-${safe_phase}.jsonl"
}

debug_append_json() {
  local phase="$1"
  local json_line="$2"

  if ! debug_is_enabled "${DEBUG_ENABLED:-1}"; then
    return 0
  fi
  if [ -z "$json_line" ]; then
    return 0
  fi
  if [ -z "$phase" ]; then
    phase="unknown"
  fi

  local file
  file="$(debug_phase_file "$phase")"
  if [ -z "$file" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$file")" 2>/dev/null || true
  printf '%s\n' "$json_line" >> "$file" 2>/dev/null || true

  if [ -z "${DEBUG_PHASE_COUNTS[$phase]+x}" ]; then
    DEBUG_PHASE_COUNTS["$phase"]=0
  fi
  DEBUG_PHASE_COUNTS["$phase"]=$((DEBUG_PHASE_COUNTS["$phase"] + 1))
}

debug_write_run_start() {
  if ! debug_is_enabled "${DEBUG_ENABLED:-1}"; then
    return 0
  fi
  if [ -z "${RUN_ID:-}" ] || [ -z "${RUN_DIR:-}" ]; then
    return 0
  fi
  local phase
  phase="$(debug_phase_key "${ISSUE_PHASE:-}")"
  local ts seq event_id
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date)"
  seq="$(debug_next_seq)"
  event_id="${RUN_ID}:${seq}"
  DEBUG_RUN_START_TS="$ts"

  local json_line
  json_line="$(jq -cn \
    --arg schema "$DEBUG_SCHEMA" \
    --arg event "debug_run_start" \
    --arg ts "$ts" \
    --arg runId "$RUN_ID" \
    --arg mode "${MODE:-}" \
    --arg runner "${RUNNER:-}" \
    --arg workDir "${WORK_DIR:-}" \
    --arg stateDir "${JEEVES_STATE_DIR:-}" \
    --arg phase "$phase" \
    --arg seq "$seq" \
    --arg eventId "$event_id" \
    --arg outputMode "${OUTPUT_MODE:-}" \
    --arg maxIterations "${MAX_ITERATIONS:-}" \
    --arg debugTrace "${DEBUG_TRACE:-}" \
    '{
      schema: $schema,
      event: $event,
      ts: $ts,
      runId: $runId,
      mode: $mode,
      runner: $runner,
      workDir: $workDir,
      stateDir: $stateDir,
      phase: $phase,
      iteration: null,
      seq: ($seq | tonumber?),
      event_id: $eventId,
      outputMode: $outputMode,
      maxIterations: ($maxIterations | tonumber?),
      debugTrace: (if $debugTrace == "" then null else $debugTrace end)
    }' 2>/dev/null || true)"
  debug_append_json "$phase" "$json_line"
}

debug_write_run_end() {
  local exit_code="${1:-0}"
  if ! debug_is_enabled "${DEBUG_ENABLED:-1}"; then
    return 0
  fi
  if [ -z "${RUN_ID:-}" ] || [ -z "${RUN_DIR:-}" ]; then
    return 0
  fi
  if [ "${DEBUG_ENDED:-0}" = "1" ]; then
    return 0
  fi
  DEBUG_ENDED=1

  local ts end_epoch duration reason phase seq event_id
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date)"
  end_epoch="$(date +%s 2>/dev/null || echo "")"
  duration="0"
  if [[ "${RUN_START_EPOCH:-}" =~ ^[0-9]+$ ]] && [[ "$end_epoch" =~ ^[0-9]+$ ]]; then
    duration=$((end_epoch - RUN_START_EPOCH))
  fi
  reason="${RUN_EXIT_REASON:-}"
  if [ -z "$reason" ]; then
    if [ "$exit_code" = "0" ]; then
      reason="exit"
    else
      reason="error"
    fi
  fi

  if [ "$MODE" = "issue" ]; then
    select_issue_phase
  fi
  phase="$(debug_phase_key "${ISSUE_PHASE:-}")"
  seq="$(debug_next_seq)"
  event_id="${RUN_ID}:${seq}"

  local json_line
  json_line="$(jq -cn \
    --arg schema "$DEBUG_SCHEMA" \
    --arg event "debug_run_end" \
    --arg ts "$ts" \
    --arg runId "$RUN_ID" \
    --arg mode "${MODE:-}" \
    --arg runner "${RUNNER:-}" \
    --arg phase "$phase" \
    --arg seq "$seq" \
    --arg eventId "$event_id" \
    --arg reason "$reason" \
    --arg exitCode "$exit_code" \
    --arg duration_s "$duration" \
    --arg exitIteration "${RUN_EXIT_ITERATION:-}" \
    '{
      schema: $schema,
      event: $event,
      ts: $ts,
      runId: $runId,
      mode: $mode,
      runner: $runner,
      phase: $phase,
      iteration: ($exitIteration | tonumber?),
      seq: ($seq | tonumber?),
      event_id: $eventId,
      reason: $reason,
      exitCode: ($exitCode | tonumber?),
      duration_s: ($duration_s | tonumber?)
    }' 2>/dev/null || true)"
  debug_append_json "$phase" "$json_line"
}

debug_write_run_index() {
  local exit_code="${1:-0}"
  if ! debug_is_enabled "${DEBUG_ENABLED:-1}"; then
    return 0
  fi
  if [ -z "${RUN_ID:-}" ] || [ -z "${RUN_DIR:-}" ]; then
    return 0
  fi
  local ts end_epoch duration
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date)"
  end_epoch="$(date +%s 2>/dev/null || echo "")"
  duration="0"
  if [[ "${RUN_START_EPOCH:-}" =~ ^[0-9]+$ ]] && [[ "$end_epoch" =~ ^[0-9]+$ ]]; then
    duration=$((end_epoch - RUN_START_EPOCH))
  fi

  local files_json
  files_json="$(
    for phase in "${!DEBUG_PHASE_COUNTS[@]}"; do
      local file count
      file="$(debug_phase_file "$phase")"
      count="${DEBUG_PHASE_COUNTS[$phase]}"
      jq -cn \
        --arg phase "$phase" \
        --arg file "$file" \
        --arg count "$count" \
        '{phase:$phase, file:$file, eventCount:($count | tonumber?)}'
    done | jq -cs '.' 2>/dev/null
  )"

  local json_line
  json_line="$(jq -cn \
    --arg runId "$RUN_ID" \
    --arg schema "$DEBUG_SCHEMA" \
    --arg mode "${MODE:-}" \
    --arg runner "${RUNNER:-}" \
    --arg startedAt "${DEBUG_RUN_START_TS:-}" \
    --arg endedAt "$ts" \
    --arg duration_s "$duration" \
    --arg exitCode "$exit_code" \
    --arg reason "${RUN_EXIT_REASON:-}" \
    --argjson files "${files_json:-[]}" \
    '{
      runId: $runId,
      schema: $schema,
      mode: $mode,
      runner: $runner,
      startedAt: (if $startedAt == "" then null else $startedAt end),
      endedAt: $endedAt,
      duration_s: ($duration_s | tonumber?),
      exitCode: ($exitCode | tonumber?),
      reason: (if $reason == "" then null else $reason end),
      files: $files
    }' 2>/dev/null || true)"

  if [ -n "$json_line" ]; then
    printf '%s\n' "$json_line" > "${RUN_DIR}/run-index.json" 2>/dev/null || true
  fi
}

debug_write_iteration_start() {
  local iteration="${1:-}"
  local phase="${2:-}"
  if ! debug_is_enabled "${DEBUG_ENABLED:-1}"; then
    return 0
  fi
  local ts seq event_id prompt_bytes append_bytes
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date)"
  seq="$(debug_next_seq)"
  event_id="${RUN_ID}:${seq}"
  prompt_bytes="0"
  if [ -f "${PROMPT_FILE_TO_USE:-}" ]; then
    prompt_bytes="$(wc -c < "$PROMPT_FILE_TO_USE" 2>/dev/null | tr -d '[:space:]' || echo "0")"
  fi
  append_bytes="0"
  if [ -n "${PROMPT_APPEND_FILE:-}" ] && [ -f "${PROMPT_APPEND_FILE:-}" ]; then
    append_bytes="$(wc -c < "$PROMPT_APPEND_FILE" 2>/dev/null | tr -d '[:space:]' || echo "0")"
  fi

  local json_line
  json_line="$(jq -cn \
    --arg schema "$DEBUG_SCHEMA" \
    --arg event "debug_iteration_start" \
    --arg ts "$ts" \
    --arg runId "$RUN_ID" \
    --arg mode "${MODE:-}" \
    --arg runner "${RUNNER:-}" \
    --arg workDir "${WORK_DIR:-}" \
    --arg stateDir "${JEEVES_STATE_DIR:-}" \
    --arg iteration "$iteration" \
    --arg phase "$phase" \
    --arg seq "$seq" \
    --arg eventId "$event_id" \
    --arg promptTemplate "${PROMPT_FILE:-}" \
    --arg promptEffective "${PROMPT_FILE_TO_USE:-}" \
    --arg promptAppend "${PROMPT_APPEND_FILE:-}" \
    --arg promptBytes "$prompt_bytes" \
    --arg promptAppendBytes "$append_bytes" \
    '{
      schema: $schema,
      event: $event,
      ts: $ts,
      runId: $runId,
      mode: $mode,
      runner: $runner,
      workDir: $workDir,
      stateDir: $stateDir,
      iteration: ($iteration | tonumber?),
      phase: $phase,
      seq: ($seq | tonumber?),
      event_id: $eventId,
      prompt: {
        template: (if $promptTemplate == "" then null else $promptTemplate end),
        effective: (if $promptEffective == "" then null else $promptEffective end),
        appendFile: (if $promptAppend == "" then null else $promptAppend end),
        bytes: ($promptBytes | tonumber?),
        appendBytes: ($promptAppendBytes | tonumber?)
      }
    }' 2>/dev/null || true)"
  debug_append_json "$phase" "$json_line"
}

debug_write_runner_invoke() {
  local iteration="${1:-}"
  local phase="${2:-}"
  local attempt="${3:-1}"
  local ts seq event_id
  if ! debug_is_enabled "${DEBUG_ENABLED:-1}"; then
    return 0
  fi
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date)"
  seq="$(debug_next_seq)"
  event_id="${RUN_ID}:${seq}"

  local json_line
  json_line="$(jq -cn \
    --arg schema "$DEBUG_SCHEMA" \
    --arg event "debug_runner_invoke" \
    --arg ts "$ts" \
    --arg runId "$RUN_ID" \
    --arg mode "${MODE:-}" \
    --arg runner "${RUNNER:-}" \
    --arg iteration "$iteration" \
    --arg phase "$phase" \
    --arg seq "$seq" \
    --arg eventId "$event_id" \
    --arg attempt "$attempt" \
    --arg outputMode "${OUTPUT_MODE:-}" \
    --arg codexDangerous "${CODEX_DANGEROUS:-}" \
    --arg codexSandbox "${CODEX_SANDBOX:-}" \
    --arg claudeSandbox "${CLAUDE_SANDBOX:-}" \
    --arg claudeDangerous "${CLAUDE_DANGEROUS_SKIP_PERMISSIONS:-}" \
    '{
      schema: $schema,
      event: $event,
      ts: $ts,
      runId: $runId,
      mode: $mode,
      runner: $runner,
      iteration: ($iteration | tonumber?),
      phase: $phase,
      seq: ($seq | tonumber?),
      event_id: $eventId,
      attempt: ($attempt | tonumber?),
      outputMode: $outputMode,
      codex: {
        dangerousBypass: ($codexDangerous == "1"),
        sandbox: (if $codexSandbox == "" then null else $codexSandbox end)
      },
      claude: {
        sandbox: (if $claudeSandbox == "" then null else ($claudeSandbox | tonumber?) end),
        dangerousSkipPermissions: ($claudeDangerous == "1")
      }
    }' 2>/dev/null || true)"
  debug_append_json "$phase" "$json_line"
}

debug_line_kind() {
  local line="$1"
  if [[ "$line" =~ ^exec([[:space:]:]|$) ]]; then
    echo "exec"
  elif [[ "$line" =~ ^file\ update: ]]; then
    echo "file_update"
  elif [[ "$line" =~ \[WARN\] ]] || [[ "$line" =~ ^WARN ]]; then
    echo "warn"
  elif [[ "$line" =~ \[ERROR\] ]] || [[ "$line" =~ ^ERROR ]]; then
    echo "error"
  else
    echo "other"
  fi
}

debug_write_log_lines() {
  local iteration="${1:-}"
  local phase="${2:-}"
  local log_file="${3:-}"
  if ! debug_is_enabled "${DEBUG_ENABLED:-1}"; then
    return 0
  fi
  if ! debug_trace_is_full "${DEBUG_TRACE:-full}"; then
    return 0
  fi
  if [ ! -f "$log_file" ]; then
    return 0
  fi
  local line line_no kind ts seq event_id
  line_no=0
  while IFS= read -r line || [ -n "$line" ]; do
    line_no=$((line_no + 1))
    kind="$(debug_line_kind "$line")"
    ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date)"
    seq="$(debug_next_seq)"
    event_id="${RUN_ID}:${seq}"
    local json_line
    json_line="$(jq -cn \
      --arg schema "$DEBUG_SCHEMA" \
      --arg event "debug_log_line" \
      --arg ts "$ts" \
      --arg runId "$RUN_ID" \
      --arg mode "${MODE:-}" \
      --arg runner "${RUNNER:-}" \
      --arg iteration "$iteration" \
      --arg phase "$phase" \
      --arg seq "$seq" \
      --arg eventId "$event_id" \
      --arg lineNo "$line_no" \
      --arg kind "$kind" \
      --arg raw "$line" \
      '{
        schema: $schema,
        event: $event,
        ts: $ts,
        runId: $runId,
        mode: $mode,
        runner: $runner,
        iteration: ($iteration | tonumber?),
        phase: $phase,
        seq: ($seq | tonumber?),
        event_id: $eventId,
        line_no: ($lineNo | tonumber?),
        kind: $kind,
        raw: $raw
      }' 2>/dev/null || true)"
    debug_append_json "$phase" "$json_line"
  done < "$log_file"
}

debug_write_iteration_end() {
  local iteration="${1:-}"
  local phase="${2:-}"
  local duration="${3:-0}"
  local output_bytes="${4:-0}"
  local runner_calls="${5:-0}"
  local runner_log_bytes="${6:-0}"
  local runner_log_lines="${7:-0}"
  local last_message_bytes="${8:-0}"
  local exec_count="${9:-0}"
  local file_update_count="${10:-0}"
  local completed="${11:-false}"
  local completion_reason="${12:-}"
  if ! debug_is_enabled "${DEBUG_ENABLED:-1}"; then
    return 0
  fi
  local ts seq event_id
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date)"
  seq="$(debug_next_seq)"
  event_id="${RUN_ID}:${seq}"

  local json_line
  json_line="$(jq -cn \
    --arg schema "$DEBUG_SCHEMA" \
    --arg event "debug_iteration_end" \
    --arg ts "$ts" \
    --arg runId "$RUN_ID" \
    --arg mode "${MODE:-}" \
    --arg runner "${RUNNER:-}" \
    --arg iteration "$iteration" \
    --arg phase "$phase" \
    --arg seq "$seq" \
    --arg eventId "$event_id" \
    --arg duration_s "$duration" \
    --arg output_bytes "$output_bytes" \
    --arg runner_calls "$runner_calls" \
    --arg runner_log_bytes "$runner_log_bytes" \
    --arg runner_log_lines "$runner_log_lines" \
    --arg last_message_bytes "$last_message_bytes" \
    --arg exec_count "$exec_count" \
    --arg file_update_count "$file_update_count" \
    --arg completed "$completed" \
    --arg completion_reason "$completion_reason" \
    '{
      schema: $schema,
      event: $event,
      ts: $ts,
      runId: $runId,
      mode: $mode,
      runner: $runner,
      iteration: ($iteration | tonumber?),
      phase: $phase,
      seq: ($seq | tonumber?),
      event_id: $eventId,
      duration_s: ($duration_s | tonumber?),
      output_bytes: ($output_bytes | tonumber?),
      runnerStats: {
        calls: ($runner_calls | tonumber?),
        logBytes: ($runner_log_bytes | tonumber?),
        logLines: ($runner_log_lines | tonumber?),
        lastMessageBytes: ($last_message_bytes | tonumber?),
        execCount: ($exec_count | tonumber?),
        fileUpdateCount: ($file_update_count | tonumber?)
      },
      completed: ($completed == "true"),
      completionReason: (if $completion_reason == "" then null else $completion_reason end)
    }' 2>/dev/null || true)"
  debug_append_json "$phase" "$json_line"
}

metrics_write_run_start() {
  if [ "${METRICS_STARTED:-0}" = "1" ]; then
    return 0
  fi
  if ! metrics_is_enabled "${METRICS_ENABLED:-1}"; then
    return 0
  fi
  if [ -z "${METRICS_FILE:-}" ] || [ -z "${RUN_ID:-}" ]; then
    return 0
  fi

  local ts branchName issueNumber issueRepo
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date)"
  branchName=""
  if [ -f "${CONFIG_FILE:-}" ]; then
    branchName="$(jq -r '.branchName // empty' "$CONFIG_FILE" 2>/dev/null || echo "")"
  fi
  issueNumber=""
  issueRepo=""
  if [ "${MODE:-}" = "issue" ] && [ -f "${CONFIG_FILE:-}" ]; then
    issueNumber="$(jq -r '.issue.number // .issueNumber // empty' "$CONFIG_FILE" 2>/dev/null || echo "")"
    issueRepo="$(jq -r '.issue.repo // empty' "$CONFIG_FILE" 2>/dev/null || echo "")"
  fi

  local json_line
  json_line="$(jq -cn \
    --arg event "run_start" \
    --arg ts "$ts" \
    --arg runId "$RUN_ID" \
    --arg mode "${MODE:-}" \
    --arg runner "${RUNNER:-}" \
    --arg workDir "${WORK_DIR:-}" \
    --arg stateDir "${JEEVES_STATE_DIR:-}" \
    --arg scriptDir "${SCRIPT_DIR:-}" \
    --arg configFile "${CONFIG_FILE:-}" \
    --arg outputMode "${OUTPUT_MODE:-}" \
    --arg maxIterations "${MAX_ITERATIONS:-}" \
    --arg branchName "$branchName" \
    --arg issueNumber "$issueNumber" \
    --arg issueRepo "$issueRepo" \
    --arg codexApprovalPolicy "${CODEX_APPROVAL_POLICY:-}" \
    --arg codexSandbox "${CODEX_SANDBOX:-}" \
    --arg codexDangerous "${CODEX_DANGEROUS:-}" \
    --arg claudeSandbox "${CLAUDE_SANDBOX:-}" \
    --arg claudeDangerousSkipPermissions "${CLAUDE_DANGEROUS_SKIP_PERMISSIONS:-}" \
    '{
      event: $event,
      ts: $ts,
      runId: $runId,
      mode: $mode,
      runner: $runner,
      branchName: (if $branchName == "" then null else $branchName end),
      issue: (if $mode == "issue" then {
        number: ($issueNumber | tonumber?),
        repo: (if $issueRepo == "" then null else $issueRepo end)
      } else null end),
      workDir: $workDir,
      stateDir: $stateDir,
      scriptDir: $scriptDir,
      configFile: $configFile,
      outputMode: $outputMode,
      maxIterations: ($maxIterations | tonumber?),
      codex: {
        approvalPolicy: $codexApprovalPolicy,
        sandbox: $codexSandbox,
        dangerousBypass: ($codexDangerous == "1")
      },
      claude: {
        sandbox: ($claudeSandbox | tonumber?),
        dangerousSkipPermissions: ($claudeDangerousSkipPermissions == "1")
      }
    }' 2>/dev/null || true)"
  metrics_append_json "$json_line"

  # Persist a run info file for the viewer + for quick run discovery.
  if [ -n "${RUN_DIR:-}" ] && [ -n "${CURRENT_RUN_FILE:-}" ]; then
    local run_info_json
    run_info_json="$(jq -cn \
      --arg runId "$RUN_ID" \
      --arg dir "${RUN_DIR:-}" \
      --arg startedAt "$ts" \
      --arg mode "${MODE:-}" \
      --arg runner "${RUNNER:-}" \
      --arg branchName "$branchName" \
      --arg issueNumber "$issueNumber" \
      --arg issueRepo "$issueRepo" \
      --arg outputMode "${OUTPUT_MODE:-}" \
      --arg maxIterations "${MAX_ITERATIONS:-}" \
      --arg metricsFile "${RUN_METRICS_FILE:-}" \
      --arg metricsAllFile "${METRICS_FILE:-}" \
      --arg activeLogFile "${LAST_RUN_LOG_FILE:-}" \
      --arg iterationsDir "${RUN_ITERATIONS_DIR:-}" \
      '{
        runId: $runId,
        dir: $dir,
        startedAt: $startedAt,
        endedAt: null,
        duration_s: null,
        exitCode: null,
        reason: null,
        mode: $mode,
        runner: $runner,
        branchName: (if $branchName == "" then null else $branchName end),
        issue: (if $mode == "issue" then {
          number: ($issueNumber | tonumber?),
          repo: (if $issueRepo == "" then null else $issueRepo end)
        } else null end),
        outputMode: $outputMode,
        maxIterations: ($maxIterations | tonumber?),
        metricsFile: (if $metricsFile == "" then null else $metricsFile end),
        metricsAllFile: (if $metricsAllFile == "" then null else $metricsAllFile end),
        activeLogFile: (if $activeLogFile == "" then null else $activeLogFile end),
        iterationsDir: (if $iterationsDir == "" then null else $iterationsDir end)
      }' 2>/dev/null || true)"

    if [ -n "$run_info_json" ]; then
      printf '%s\n' "$run_info_json" > "$CURRENT_RUN_FILE" 2>/dev/null || true
      if [ -n "${RUN_INFO_FILE:-}" ]; then
        printf '%s\n' "$run_info_json" > "$RUN_INFO_FILE" 2>/dev/null || true
      fi
    fi
  fi

  METRICS_STARTED=1
}

metrics_write_iteration_start() {
  local iteration="${1:-}"
  if ! metrics_is_enabled "${METRICS_ENABLED:-1}"; then
    return 0
  fi
  if [ "${METRICS_STARTED:-0}" != "1" ]; then
    return 0
  fi
  if [ -z "${METRICS_FILE:-}" ] || [ -z "${RUN_ID:-}" ]; then
    return 0
  fi

  local ts promptBytes promptAppendBytes
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date)"
  promptBytes="0"
  if [ -f "${PROMPT_FILE_TO_USE:-}" ]; then
    promptBytes="$(wc -c < "$PROMPT_FILE_TO_USE" 2>/dev/null | tr -d '[:space:]' || echo "0")"
  fi
  promptAppendBytes="0"
  if [ -n "${PROMPT_APPEND_FILE:-}" ] && [ -f "${PROMPT_APPEND_FILE:-}" ]; then
    promptAppendBytes="$(wc -c < "$PROMPT_APPEND_FILE" 2>/dev/null | tr -d '[:space:]' || echo "0")"
  fi

  local json_line
  json_line="$(jq -cn \
    --arg event "iteration_start" \
    --arg ts "$ts" \
    --arg runId "$RUN_ID" \
    --arg iteration "$iteration" \
    --arg mode "${MODE:-}" \
    --arg phase "${ISSUE_PHASE:-}" \
    --arg promptFile "${PROMPT_FILE:-}" \
    --arg promptFileToUse "${PROMPT_FILE_TO_USE:-}" \
    --arg promptAppendFile "${PROMPT_APPEND_FILE:-}" \
    --arg promptBytes "$promptBytes" \
    --arg promptAppendBytes "$promptAppendBytes" \
    --arg storiesRemaining "${REMAINING:-}" \
    --arg storiesPassing "${PASSING_COUNT:-}" \
    --arg storiesTotal "${STORY_COUNT:-}" \
    --arg issueStatusImplemented "${ISSUE_STATUS_IMPLEMENTED:-}" \
    --arg issueStatusPrCreated "${ISSUE_STATUS_PR_CREATED:-}" \
    --arg issueStatusPrDescriptionReady "${ISSUE_STATUS_PR_DESCRIPTION_READY:-}" \
    --arg issueStatusReviewClean "${ISSUE_STATUS_REVIEW_CLEAN:-}" \
    --arg issueStatusCiClean "${ISSUE_STATUS_CI_CLEAN:-}" \
    --arg issueStatusCoverageClean "${ISSUE_STATUS_COVERAGE_CLEAN:-}" \
    --arg issueStatusCoverageNeedsFix "${ISSUE_STATUS_COVERAGE_NEEDS_FIX:-}" \
    --arg issueStatusSonarClean "${ISSUE_STATUS_SONAR_CLEAN:-}" \
    '{
      event: $event,
      ts: $ts,
      runId: $runId,
      iteration: ($iteration | tonumber?),
      mode: $mode,
      phase: (if $mode == "issue" then $phase else null end),
      prompt: {
        template: $promptFile,
        effective: $promptFileToUse,
        appendFile: (if $promptAppendFile == "" then null else $promptAppendFile end),
        bytes: ($promptBytes | tonumber?),
        appendBytes: ($promptAppendBytes | tonumber?)
      },
      issue: {
        status: {
          implemented: ($issueStatusImplemented == "true"),
          prCreated: ($issueStatusPrCreated == "true"),
          prDescriptionReady: ($issueStatusPrDescriptionReady == "true"),
          reviewClean: ($issueStatusReviewClean == "true"),
          ciClean: ($issueStatusCiClean == "true"),
          coverageClean: ($issueStatusCoverageClean == "true"),
          coverageNeedsFix: ($issueStatusCoverageNeedsFix == "true"),
          sonarClean: ($issueStatusSonarClean == "true")
        }
      }
    }' 2>/dev/null || true)"
  metrics_append_json "$json_line"
}

metrics_write_iteration_end() {
  local iteration="${1:-}"
  local duration="${2:-}"
  local outputBytes="${3:-}"
  local runnerCalls="${4:-}"
  local runnerLogBytes="${5:-}"
  local runnerLogLines="${6:-}"
  local lastMessageBytes="${7:-}"
  local execCount="${8:-}"
  local fileUpdateCount="${9:-}"
  local completed="${10:-false}"
  local completionReason="${11:-}"
  local phaseRan="${12:-}"
  local phaseValue
  phaseValue="$phaseRan"
  if [ -z "$phaseValue" ]; then
    phaseValue="${ISSUE_PHASE:-}"
  fi

  if ! metrics_is_enabled "${METRICS_ENABLED:-1}"; then
    return 0
  fi
  if [ "${METRICS_STARTED:-0}" != "1" ]; then
    return 0
  fi
  if [ -z "${METRICS_FILE:-}" ] || [ -z "${RUN_ID:-}" ]; then
    return 0
  fi

  local ts
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date)"

	  local json_line
	  json_line="$(jq -cn \
	    --arg event "iteration_end" \
	    --arg ts "$ts" \
	    --arg runId "$RUN_ID" \
	    --arg iteration "$iteration" \
	    --arg mode "${MODE:-}" \
	    --arg phase "$phaseValue" \
	    --arg duration_s "$duration" \
	    --arg output_bytes "$outputBytes" \
	    --arg runner_calls "$runnerCalls" \
	    --arg runner_log_bytes "$runnerLogBytes" \
    --arg runner_log_lines "$runnerLogLines" \
    --arg last_message_bytes "$lastMessageBytes" \
    --arg exec_count "$execCount" \
    --arg file_update_count "$fileUpdateCount" \
    --arg completed "$completed" \
    --arg completion_reason "$completionReason" \
    --arg storiesRemaining "${REMAINING:-}" \
    --arg storiesPassing "${NEW_PASSING:-$PASSING_COUNT}" \
    --arg storiesTotal "${STORY_COUNT:-}" \
    --arg issueStatusImplemented "${ISSUE_STATUS_IMPLEMENTED:-}" \
    --arg issueStatusPrCreated "${ISSUE_STATUS_PR_CREATED:-}" \
    --arg issueStatusPrDescriptionReady "${ISSUE_STATUS_PR_DESCRIPTION_READY:-}" \
    --arg issueStatusReviewClean "${ISSUE_STATUS_REVIEW_CLEAN:-}" \
    --arg issueStatusCiClean "${ISSUE_STATUS_CI_CLEAN:-}" \
    --arg issueStatusCoverageClean "${ISSUE_STATUS_COVERAGE_CLEAN:-}" \
    --arg issueStatusCoverageNeedsFix "${ISSUE_STATUS_COVERAGE_NEEDS_FIX:-}" \
    --arg issueStatusSonarClean "${ISSUE_STATUS_SONAR_CLEAN:-}" \
    '{
      event: $event,
      ts: $ts,
      runId: $runId,
      iteration: ($iteration | tonumber?),
      mode: $mode,
      phase: (if $mode == "issue" then $phase else null end),
      duration_s: ($duration_s | tonumber?),
      output: {
        bytes: ($output_bytes | tonumber?)
      },
      runner: {
        calls: ($runner_calls | tonumber?),
        logBytes: ($runner_log_bytes | tonumber?),
        logLines: ($runner_log_lines | tonumber?),
        lastMessageBytes: ($last_message_bytes | tonumber?),
        execCount: ($exec_count | tonumber?),
        fileUpdateCount: ($file_update_count | tonumber?)
      },
      completed: ($completed == "true"),
      completionReason: (if $completion_reason == "" then null else $completion_reason end),
      issue: {
        status: {
          implemented: ($issueStatusImplemented == "true"),
          prCreated: ($issueStatusPrCreated == "true"),
          prDescriptionReady: ($issueStatusPrDescriptionReady == "true"),
          reviewClean: ($issueStatusReviewClean == "true"),
          ciClean: ($issueStatusCiClean == "true"),
          coverageClean: ($issueStatusCoverageClean == "true"),
          coverageNeedsFix: ($issueStatusCoverageNeedsFix == "true"),
          sonarClean: ($issueStatusSonarClean == "true")
        }
      }
    }' 2>/dev/null || true)"
  metrics_append_json "$json_line"
}

metrics_write_run_end() {
  local exit_code="${1:-0}"
  if ! metrics_is_enabled "${METRICS_ENABLED:-1}"; then
    return 0
  fi
  if [ "${METRICS_STARTED:-0}" != "1" ]; then
    return 0
  fi
  if [ "${METRICS_ENDED:-0}" = "1" ]; then
    return 0
  fi
  if [ -z "${METRICS_FILE:-}" ] || [ -z "${RUN_ID:-}" ]; then
    return 0
  fi

  METRICS_ENDED=1

  local ts end_epoch duration
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date)"
  end_epoch="$(date +%s 2>/dev/null || echo "")"
  duration="0"
  if [[ "${RUN_START_EPOCH:-}" =~ ^[0-9]+$ ]] && [[ "$end_epoch" =~ ^[0-9]+$ ]]; then
    duration=$((end_epoch - RUN_START_EPOCH))
  fi

  local reason
  reason="${RUN_EXIT_REASON:-}"
  if [ -z "$reason" ]; then
    if [ "$exit_code" = "0" ]; then
      reason="exit"
    else
      reason="error"
    fi
  fi

  local json_line
  json_line="$(jq -cn \
    --arg event "run_end" \
    --arg ts "$ts" \
    --arg runId "$RUN_ID" \
    --arg mode "${MODE:-}" \
    --arg runner "${RUNNER:-}" \
    --arg reason "$reason" \
    --arg exitCode "$exit_code" \
    --arg duration_s "$duration" \
    --arg exitIteration "${RUN_EXIT_ITERATION:-}" \
    '{
      event: $event,
      ts: $ts,
      runId: $runId,
      mode: $mode,
      runner: $runner,
      reason: $reason,
      exitCode: ($exitCode | tonumber?),
      duration_s: ($duration_s | tonumber?),
      exitIteration: ($exitIteration | tonumber?)
    }' 2>/dev/null || true)"
  metrics_append_json "$json_line"

  # Update run info files with completion metadata (best-effort).
  if [ -n "${CURRENT_RUN_FILE:-}" ] && [ -f "${CURRENT_RUN_FILE:-}" ]; then
    local tmpRunInfo
    tmpRunInfo="$(mktemp "${JEEVES_STATE_DIR:-/tmp}/current-run.json.tmp.XXXXXX" 2>/dev/null || echo "")"
    if [ -n "$tmpRunInfo" ]; then
      jq \
        --arg endedAt "$ts" \
        --arg reason "$reason" \
        --arg exitCode "$exit_code" \
        --arg duration_s "$duration" \
        '.endedAt=$endedAt
        | .reason=$reason
        | .exitCode=($exitCode | tonumber?)
        | .duration_s=($duration_s | tonumber?)' "$CURRENT_RUN_FILE" > "$tmpRunInfo" 2>/dev/null || true
      if [ -s "$tmpRunInfo" ]; then
        mv "$tmpRunInfo" "$CURRENT_RUN_FILE"
      else
        rm -f "$tmpRunInfo" 2>/dev/null || true
      fi
    fi
  fi

  if [ -n "${RUN_INFO_FILE:-}" ] && [ -f "${RUN_INFO_FILE:-}" ]; then
    local tmpRunInfo
    tmpRunInfo="$(mktemp "${RUN_DIR:-/tmp}/run.json.tmp.XXXXXX" 2>/dev/null || echo "")"
    if [ -n "$tmpRunInfo" ]; then
      jq \
        --arg endedAt "$ts" \
        --arg reason "$reason" \
        --arg exitCode "$exit_code" \
        --arg duration_s "$duration" \
        '.endedAt=$endedAt
        | .reason=$reason
        | .exitCode=($exitCode | tonumber?)
        | .duration_s=($duration_s | tonumber?)' "$RUN_INFO_FILE" > "$tmpRunInfo" 2>/dev/null || true
      if [ -s "$tmpRunInfo" ]; then
        mv "$tmpRunInfo" "$RUN_INFO_FILE"
      else
        rm -f "$tmpRunInfo" 2>/dev/null || true
      fi
    fi
  fi
}

cleanup_on_exit() {
  local exit_code=$?
  metrics_write_run_end "$exit_code"
  debug_write_run_end "$exit_code"
  debug_write_run_index "$exit_code"
  if [ -n "${RUN_DIR:-}" ] && [ -d "${RUN_DIR:-}" ]; then
    mkdir -p "$RUN_DIR" 2>/dev/null || true
    if [ -n "${RUN_ITERATIONS_DIR:-}" ]; then
      mkdir -p "$RUN_ITERATIONS_DIR" 2>/dev/null || true
    fi

    [ -f "${ISSUE_FILE:-}" ] && cp "${ISSUE_FILE:-}" "$RUN_DIR/" 2>/dev/null || true
    [ -f "${PROGRESS_FILE:-}" ] && cp "${PROGRESS_FILE:-}" "$RUN_DIR/" 2>/dev/null || true
    [ -f "${LAST_RUN_LOG_FILE:-}" ] && cp "${LAST_RUN_LOG_FILE:-}" "$RUN_DIR/last-run.log" 2>/dev/null || true
    [ -f "${LAST_MESSAGE_FILE:-}" ] && cp "${LAST_MESSAGE_FILE:-}" "$RUN_DIR/last-message.txt" 2>/dev/null || true
    [ -f "${OPEN_QUESTIONS_FILE:-}" ] && cp "${OPEN_QUESTIONS_FILE:-}" "$RUN_DIR/" 2>/dev/null || true
    [ -f "${COVERAGE_FAILURES_FILE:-}" ] && cp "${COVERAGE_FAILURES_FILE:-}" "$RUN_DIR/" 2>/dev/null || true
    [ -f "${JEEVES_STATE_DIR:-}/review.md" ] && cp "${JEEVES_STATE_DIR:-}/review.md" "$RUN_DIR/" 2>/dev/null || true
    [ -f "${JEEVES_STATE_DIR:-}/sonar-issues.json" ] && cp "${JEEVES_STATE_DIR:-}/sonar-issues.json" "$RUN_DIR/" 2>/dev/null || true
  fi
  cleanup_tmp_prompt
}

trap cleanup_on_exit EXIT

print_usage() {
    cat <<EOF
Usage: $0 [OPTIONS] [max_iterations]

Options:
    --runner RUNNER      Set runner to 'sdk' (default), 'codex', 'claude', or 'opencode' (overrides JEEVES_RUNNER)
     --codex              Use Codex runner (same as --runner codex)
     --claude             Use Claude runner (same as --runner claude)
     --opencode           Use Opencode runner (same as --runner opencode)
    --max-iterations N   Set maximum iterations (default: 10)
    --metrics            Enable JSONL metrics (default: on)
    --no-metrics         Disable JSONL metrics
    --metrics-file PATH  Override metrics output path (default: \$JEEVES_STATE_DIR/metrics.jsonl)
    --help               Show this help message

Environment variables:
    JEEVES_RUNNER         Runner selection (codex|claude|opencode|auto)
    JEEVES_RUN_ID         Optional run id (used as a prefix for the run folder name)
    JEEVES_RUNS_DIR       Override per-run artifacts directory (default: \$JEEVES_STATE_DIR/.runs)
    JEEVES_METRICS        Set to 0 to disable metrics (default: 1)
    JEEVES_METRICS_FILE   Override metrics output path
    JEEVES_DEBUG          Set to 0 to disable debug JSONL (default: 1)
    JEEVES_DEBUG_TRACE    Debug trace level (full|summary) (default: full)
    JEEVES_CODEX_APPROVAL_POLICY, JEEVES_CODEX_SANDBOX, JEEVES_CODEX_DANGEROUS
    JEEVES_CLAUDE_SANDBOX, JEEVES_CLAUDE_DANGEROUS_SKIP_PERMISSIONS
    JEEVES_MODE, JEEVES_WORK_DIR, JEEVES_STATE_DIR, etc.

If no options are given, the first positional argument is treated as max_iterations.
EOF
}

# Default values
MAX_ITERATIONS=10
RUNNER_ARG=""
METRICS_ENABLED_ARG=""
METRICS_FILE_ARG=""

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --runner)
            if [[ -z $2 ]]; then
                echo "Error: --runner requires an argument (sdk|codex|claude|opencode)" >&2
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
        --metrics)
            METRICS_ENABLED_ARG="1"
            shift
            ;;
        --no-metrics)
            METRICS_ENABLED_ARG="0"
            shift
            ;;
        --metrics-file)
            if [[ -z $2 ]]; then
                echo "Error: --metrics-file requires a path" >&2
                exit 1
            fi
            METRICS_FILE_ARG="$2"
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
    export JEEVES_RUNNER="$RUNNER_ARG"
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${JEEVES_WORK_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# State lives in a jeeves/ subfolder of working directory by default
JEEVES_STATE_DIR="${JEEVES_STATE_DIR:-$WORK_DIR/jeeves}"
ISSUE_FILE="$JEEVES_STATE_DIR/issue.json"
PROGRESS_FILE="$JEEVES_STATE_DIR/progress.txt"
ARCHIVE_DIR="$JEEVES_STATE_DIR/.archive"
LAST_BRANCH_FILE="$JEEVES_STATE_DIR/.last-branch"
OPEN_QUESTIONS_FILE="$JEEVES_STATE_DIR/open-questions.md"
COVERAGE_FAILURES_FILE="$JEEVES_STATE_DIR/coverage-failures.md"

METRICS_ENABLED="${JEEVES_METRICS:-1}"
if [ -n "$METRICS_ENABLED_ARG" ]; then
  METRICS_ENABLED="$METRICS_ENABLED_ARG"
fi
METRICS_FILE="${JEEVES_METRICS_FILE:-$JEEVES_STATE_DIR/metrics.jsonl}"
if [ -n "$METRICS_FILE_ARG" ]; then
  METRICS_FILE="$METRICS_FILE_ARG"
fi
RUNS_DIR="${JEEVES_RUNS_DIR:-$JEEVES_STATE_DIR/.runs}"
RUN_ID_BASE="${JEEVES_RUN_ID:-$(date -u +"%Y%m%dT%H%M%SZ" 2>/dev/null || date +%s)-$$}"
RUN_ID=""
RUN_DIR=""
RUN_INFO_FILE=""
CURRENT_RUN_FILE="$JEEVES_STATE_DIR/current-run.json"
RUN_ITERATIONS_DIR=""
RUN_METRICS_FILE=""
RUN_START_EPOCH="$(date +%s 2>/dev/null || echo "")"
METRICS_STARTED=0
METRICS_ENDED=0
DEBUG_ENABLED="${JEEVES_DEBUG:-1}"
DEBUG_TRACE="${JEEVES_DEBUG_TRACE:-full}"
DEBUG_SCHEMA="jeeves.debug.v1"
DEBUG_SEQ=0
DEBUG_RUN_START_TS=""
DEBUG_ENDED=0
declare -A DEBUG_PHASE_COUNTS

# Prompt templates are in prompts/ directory at repo root
PROMPT_ISSUE_DESIGN_FILE="$SCRIPT_DIR/prompts/issue.design.md"
PROMPT_ISSUE_IMPLEMENT_FILE="$SCRIPT_DIR/prompts/issue.implement.md"
PROMPT_ISSUE_REVIEW_FILE="$SCRIPT_DIR/prompts/issue.review.md"
PROMPT_ISSUE_CI_FILE="$SCRIPT_DIR/prompts/issue.ci.md"
PROMPT_ISSUE_COVERAGE_FILE="$SCRIPT_DIR/prompts/issue.coverage.md"
PROMPT_ISSUE_COVERAGE_FIX_FILE="$SCRIPT_DIR/prompts/issue.coverage.fix.md"
PROMPT_ISSUE_SONAR_FILE="$SCRIPT_DIR/prompts/issue.sonar.md"
PROMPT_ISSUE_QUESTIONS_FILE="$SCRIPT_DIR/prompts/issue.questions.md"
PROMPT_ISSUE_TASK_IMPLEMENT_FILE="$SCRIPT_DIR/prompts/issue.task.implement.md"
PROMPT_ISSUE_TASK_SPEC_REVIEW_FILE="$SCRIPT_DIR/prompts/issue.task.spec-review.md"
PROMPT_ISSUE_TASK_QUALITY_REVIEW_FILE="$SCRIPT_DIR/prompts/issue.task.quality-review.md"

# Optional: append extra instructions to the selected prompt each iteration.
# Useful for tooling (e.g. the viewer) that wants to inject per-run guidance without
# modifying the prompt templates in this directory.
PROMPT_APPEND_FILE="${JEEVES_PROMPT_APPEND_FILE:-}"

# Select mode + config file
MODE="${JEEVES_MODE:-auto}"
CONFIG_FILE=""
PROMPT_FILE=""
ISSUE_PHASE=""
ISSUE_STATUS_IMPLEMENTED="false"
ISSUE_STATUS_PR_CREATED="false"
ISSUE_STATUS_PR_DESCRIPTION_READY="false"
ISSUE_STATUS_REVIEW_CLEAN="false"
ISSUE_STATUS_CI_CLEAN="false"
ISSUE_STATUS_COVERAGE_CLEAN="false"
ISSUE_STATUS_COVERAGE_NEEDS_FIX="false"
ISSUE_STATUS_SONAR_CLEAN="false"
ISSUE_STATUS_TASK_STAGE=""
ISSUE_STATUS_TASK_CURRENT_ID=""
ISSUE_STATUS_TASKS_COMPLETE="false"
ISSUE_PR_NUMBER=""
ISSUE_PR_URL=""

if [ "$MODE" = "issue" ] || [ "$MODE" = "auto" ]; then
  MODE="issue"
  CONFIG_FILE="$ISSUE_FILE"
  PROMPT_FILE="$PROMPT_ISSUE_IMPLEMENT_FILE"
else
  echo "[ERROR] No Jeeves config found in: $JEEVES_STATE_DIR"
  echo "[ERROR] Create: $ISSUE_FILE"
  exit 1
fi

# Validate config exists
if [ ! -f "$CONFIG_FILE" ]; then
  echo "[ERROR] Config file not found: $CONFIG_FILE"
  exit 1
fi

# Ensure state dir exists for auxiliary files (progress, archive, last-message)
mkdir -p "$JEEVES_STATE_DIR"

# Create a unique per-run artifacts directory so multiple runs can be analyzed separately.
mkdir -p "$RUNS_DIR" 2>/dev/null || true
if command -v mktemp >/dev/null 2>&1; then
  RUN_DIR="$(mktemp -d "$RUNS_DIR/${RUN_ID_BASE}.XXXXXX" 2>/dev/null || true)"
fi
if [ -z "${RUN_DIR:-}" ]; then
  RUN_DIR="$RUNS_DIR/$RUN_ID_BASE"
  suffix=0
  while [ -e "$RUN_DIR" ]; do
    suffix=$((suffix + 1))
    RUN_DIR="$RUNS_DIR/$RUN_ID_BASE.$suffix"
  done
  mkdir -p "$RUN_DIR" 2>/dev/null || true
fi
RUN_ID="$(basename "$RUN_DIR" 2>/dev/null || echo "$RUN_ID_BASE")"
RUN_INFO_FILE="$RUN_DIR/run.json"
RUN_ITERATIONS_DIR="$RUN_DIR/iterations"
RUN_METRICS_FILE="$RUN_DIR/metrics.jsonl"
mkdir -p "$RUN_ITERATIONS_DIR" 2>/dev/null || true

pr_body_meets_requirements() {
  local body="$1"
  local issueNumber="$2"

  if [ -z "$body" ] || [ -z "$issueNumber" ] || [ "$issueNumber" = "null" ]; then
    return 1
  fi

  local fixesPattern="^[[:space:]]*fixes[[:space:]]*#[[:space:]]*${issueNumber}([^0-9]|$)"
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
  local implemented prCreated prDescriptionReady prNumber prUrl reviewClean ciClean coverageClean coverageNeedsFix sonarClean hasOpenQuestions hasCoverageFailures
  local designDocPath designDocResolved hasDesignDoc
  local tasksCount hasTasks taskStage currentTaskId selectedTaskId
  local statusTasksComplete derivedTasksComplete

  implemented=$(jq -r '.status.implemented // false' "$ISSUE_FILE" 2>/dev/null || echo "false")
  prCreated=$(jq -r '.status.prCreated // false' "$ISSUE_FILE" 2>/dev/null || echo "false")
  prDescriptionReady=$(jq -r '.status.prDescriptionReady // false' "$ISSUE_FILE" 2>/dev/null || echo "false")
  prNumber=$(jq -r '.pullRequest.number // empty' "$ISSUE_FILE" 2>/dev/null || echo "")
  prUrl=$(jq -r '.pullRequest.url // empty' "$ISSUE_FILE" 2>/dev/null || echo "")
  reviewClean=$(jq -r '.status.reviewClean // false' "$ISSUE_FILE" 2>/dev/null || echo "false")
  ciClean=$(jq -r '.status.ciClean // false' "$ISSUE_FILE" 2>/dev/null || echo "false")
  coverageClean=$(jq -r '.status.coverageClean // false' "$ISSUE_FILE" 2>/dev/null || echo "false")
  coverageNeedsFix=$(jq -r '.status.coverageNeedsFix // false' "$ISSUE_FILE" 2>/dev/null || echo "false")
  sonarClean=$(jq -r '.status.sonarClean // false' "$ISSUE_FILE" 2>/dev/null || echo "false")
  tasksCount=$(jq -r '(.tasks // []) | length' "$ISSUE_FILE" 2>/dev/null || echo "0")
  taskStage=$(jq -r '.status.taskStage // empty' "$ISSUE_FILE" 2>/dev/null || echo "")
  currentTaskId=$(jq -r '.status.currentTaskId // empty' "$ISSUE_FILE" 2>/dev/null || echo "")
  statusTasksComplete=$(jq -r '.status.tasksComplete // empty' "$ISSUE_FILE" 2>/dev/null || echo "")

  # Read config options with env var overrides
  local configReviewCleanPasses configAutoSkipTaskReviews
  configReviewCleanPasses="${JEEVES_REVIEW_CLEAN_PASSES_REQUIRED:-}"
  if [ -z "$configReviewCleanPasses" ]; then
    configReviewCleanPasses=$(jq -r '.config.reviewCleanPassesRequired // 3' "$ISSUE_FILE" 2>/dev/null || echo "3")
  fi
  export JEEVES_CONFIG_REVIEW_CLEAN_PASSES_REQUIRED="$configReviewCleanPasses"

  configAutoSkipTaskReviews="${JEEVES_AUTO_SKIP_TASK_REVIEWS:-}"
  if [ -z "$configAutoSkipTaskReviews" ]; then
    configAutoSkipTaskReviews=$(jq -r '.config.autoSkipTaskReviews // false' "$ISSUE_FILE" 2>/dev/null || echo "false")
  fi
  export JEEVES_CONFIG_AUTO_SKIP_TASK_REVIEWS="$configAutoSkipTaskReviews"

  local originalCoverageClean originalCoverageNeedsFix
  originalCoverageClean="$coverageClean"
  originalCoverageNeedsFix="$coverageNeedsFix"

  hasTasks="false"
  if [ "$tasksCount" != "0" ]; then
    hasTasks="true"
  fi

  derivedTasksComplete="false"
  if [ "$hasTasks" = "true" ]; then
    derivedTasksComplete="$(jq -r '((.tasks // []) | length) as $len | if $len == 0 then false else ([.tasks[]? | (.status // "pending")] | all(. == "done")) end' "$ISSUE_FILE" 2>/dev/null || echo "false")"
  fi

  if [ -z "$statusTasksComplete" ]; then
    statusTasksComplete="false"
  fi

  if [ "$hasTasks" = "true" ] && [ "$statusTasksComplete" != "$derivedTasksComplete" ]; then
    local tmpFile
    tmpFile="$(mktemp "$JEEVES_STATE_DIR/issue.json.tmp.XXXXXX")"
    jq \
      --argjson tasksComplete "$derivedTasksComplete" \
      '.status = (.status // {})
      | .status.tasksComplete=$tasksComplete' "$ISSUE_FILE" > "$tmpFile" 2>/dev/null || true
    if [ -s "$tmpFile" ]; then
      mv "$tmpFile" "$ISSUE_FILE"
    else
      rm -f "$tmpFile"
    fi
  fi

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

          tmpFile="$(mktemp "$JEEVES_STATE_DIR/issue.json.tmp.XXXXXX")"
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
        tmpFile="$(mktemp "$JEEVES_STATE_DIR/issue.json.tmp.XXXXXX")"
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
    tmpFile="$(mktemp "$JEEVES_STATE_DIR/issue.json.tmp.XXXXXX")"
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
  ISSUE_STATUS_CI_CLEAN="$ciClean"
  ISSUE_STATUS_COVERAGE_CLEAN="$coverageClean"
  ISSUE_STATUS_COVERAGE_NEEDS_FIX="$coverageNeedsFix"
  ISSUE_STATUS_SONAR_CLEAN="$sonarClean"
  if [ "$hasTasks" = "true" ]; then
    ISSUE_STATUS_TASKS_COMPLETE="$derivedTasksComplete"
    ISSUE_STATUS_TASK_STAGE="$taskStage"
    ISSUE_STATUS_TASK_CURRENT_ID="$currentTaskId"
  fi
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

  if [ "$hasTasks" = "true" ] && [ "$derivedTasksComplete" != "true" ]; then
    if [ -z "$currentTaskId" ] || [ "$currentTaskId" = "null" ]; then
      selectedTaskId="$(jq -r '.tasks[]? | select((.status // "pending") != "done") | .id' "$ISSUE_FILE" 2>/dev/null | head -n 1)"
      if [ -n "$selectedTaskId" ] && [ "$selectedTaskId" != "null" ]; then
        currentTaskId="$selectedTaskId"
        tmpFile="$(mktemp "$JEEVES_STATE_DIR/issue.json.tmp.XXXXXX")"
        jq \
          --arg currentTaskId "$currentTaskId" \
          '.status = (.status // {})
          | .status.currentTaskId=$currentTaskId' "$ISSUE_FILE" > "$tmpFile" 2>/dev/null || true
        if [ -s "$tmpFile" ]; then
          mv "$tmpFile" "$ISSUE_FILE"
        else
          rm -f "$tmpFile"
        fi
      else
        derivedTasksComplete="true"
        tmpFile="$(mktemp "$JEEVES_STATE_DIR/issue.json.tmp.XXXXXX")"
        jq \
          --argjson tasksComplete true \
          '.status = (.status // {})
          | .status.tasksComplete=$tasksComplete
          | .status.currentTaskId=null' "$ISSUE_FILE" > "$tmpFile" 2>/dev/null || true
        if [ -s "$tmpFile" ]; then
          mv "$tmpFile" "$ISSUE_FILE"
        else
          rm -f "$tmpFile"
        fi
      fi
    fi

    if [ "$derivedTasksComplete" != "true" ]; then
      if [ -z "$taskStage" ] || [ "$taskStage" = "null" ] || ! [[ "$taskStage" =~ ^(implement|spec-review|quality-review)$ ]]; then
        taskStage="implement"
        tmpFile="$(mktemp "$JEEVES_STATE_DIR/issue.json.tmp.XXXXXX")"
        jq \
          --arg taskStage "$taskStage" \
          '.status = (.status // {})
          | .status.taskStage=$taskStage' "$ISSUE_FILE" > "$tmpFile" 2>/dev/null || true
        if [ -s "$tmpFile" ]; then
          mv "$tmpFile" "$ISSUE_FILE"
        else
          rm -f "$tmpFile"
        fi
      fi

      ISSUE_STATUS_TASK_STAGE="$taskStage"
      ISSUE_STATUS_TASK_CURRENT_ID="$currentTaskId"
      ISSUE_STATUS_TASKS_COMPLETE="false"

      case "$taskStage" in
        spec-review)
          ISSUE_PHASE="task-spec-review"
          PROMPT_FILE="$PROMPT_ISSUE_TASK_SPEC_REVIEW_FILE"
          ;;
        quality-review)
          ISSUE_PHASE="task-quality-review"
          PROMPT_FILE="$PROMPT_ISSUE_TASK_QUALITY_REVIEW_FILE"
          ;;
        *)
          ISSUE_PHASE="task-implement"
          PROMPT_FILE="$PROMPT_ISSUE_TASK_IMPLEMENT_FILE"
          ;;
      esac
      return
    fi
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
	  elif [ "$ciClean" != "true" ]; then
	    ISSUE_PHASE="ci"
	    PROMPT_FILE="$PROMPT_ISSUE_CI_FILE"
	  else
	    ISSUE_PHASE="complete"
	    PROMPT_FILE="$PROMPT_ISSUE_SONAR_FILE"
	  fi
}

# Runner selection
RUNNER="${JEEVES_RUNNER:-auto}"

# SDK Python: prefer venv if available, else system python
SDK_VENV_PYTHON="$SCRIPT_DIR/.venv/bin/python"
if [ -x "$SDK_VENV_PYTHON" ]; then
  SDK_PYTHON="$SDK_VENV_PYTHON"
else
  SDK_PYTHON="python3"
fi

if [ "$RUNNER" = "auto" ]; then
  # SDK runner is the default (requires Python + claude-agent-sdk)
  if "$SDK_PYTHON" -c "import claude_agent_sdk" 2>/dev/null; then
    RUNNER="sdk"
  elif command -v codex >/dev/null 2>&1; then
    RUNNER="codex"
  elif command -v claude >/dev/null 2>&1; then
    RUNNER="claude"
  elif command -v opencode >/dev/null 2>&1; then
    RUNNER="opencode"
  else
    echo "[ERROR] No supported agent runner found."
    echo "  - Create venv: python3 -m venv .venv && .venv/bin/pip install claude-agent-sdk"
    echo "  - Or install Codex CLI, Claude CLI, or Opencode CLI"
    exit 1
  fi
fi

# SDK runner settings (used when RUNNER=sdk)
SDK_OUTPUT_FILE="${JEEVES_SDK_OUTPUT:-$JEEVES_STATE_DIR/sdk-output.json}"

CODEX_APPROVAL_POLICY="${JEEVES_CODEX_APPROVAL_POLICY:-never}"
CODEX_SANDBOX="${JEEVES_CODEX_SANDBOX:-danger-full-access}"
CODEX_DANGEROUS="${JEEVES_CODEX_DANGEROUS:-1}"

CLAUDE_SANDBOX="${JEEVES_CLAUDE_SANDBOX:-1}"
CLAUDE_DANGEROUS_SKIP_PERMISSIONS="${JEEVES_CLAUDE_DANGEROUS_SKIP_PERMISSIONS:-1}"

OUTPUT_MODE="${JEEVES_OUTPUT_MODE:-compact}"
PRINT_PROMPT="${JEEVES_PRINT_PROMPT:-1}"
LAST_RUN_LOG_FILE="${JEEVES_LAST_RUN_LOG_FILE:-$JEEVES_STATE_DIR/last-run.log}"

echo "╔═══════════════════════════════════════════════════════╗"
echo "║              Jeeves Wiggum - AI Agent Loop             ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""
echo "[DEBUG] Script directory: $SCRIPT_DIR"
echo "[DEBUG] Working directory: $WORK_DIR"
echo "[DEBUG] Jeeves state directory: $JEEVES_STATE_DIR"
echo "[DEBUG] Run ID: $RUN_ID"
echo "[DEBUG] Run artifacts directory: $RUN_DIR"
echo "[DEBUG] Mode: $MODE"
echo "[DEBUG] Config file: $CONFIG_FILE"
echo "[DEBUG] Progress file: $PROGRESS_FILE"
echo "[DEBUG] Runner: $RUNNER"
echo "[DEBUG] Output mode: $OUTPUT_MODE"
echo "[DEBUG] Metrics enabled: $METRICS_ENABLED"
echo "[DEBUG] Metrics file (all runs): $METRICS_FILE"
echo "[DEBUG] Metrics file (this run): $RUN_METRICS_FILE"
if [ "$RUNNER" = "codex" ]; then
  echo "[DEBUG] Codex approval policy: $CODEX_APPROVAL_POLICY"
  echo "[DEBUG] Codex sandbox: $CODEX_SANDBOX"
  echo "[DEBUG] Codex dangerous bypass: $CODEX_DANGEROUS"
elif [ "$RUNNER" = "claude" ]; then
  echo "[DEBUG] Claude sandbox: $CLAUDE_SANDBOX"
  echo "[DEBUG] Claude dangerous skip permissions: $CLAUDE_DANGEROUS_SKIP_PERMISSIONS"
elif [ "$RUNNER" = "sdk" ]; then
  echo "[DEBUG] SDK output file: $SDK_OUTPUT_FILE"
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
    # Strip "jeeves/" prefix from branch name for folder
    FOLDER_NAME=$(echo "$LAST_BRANCH" | sed 's|^jeeves/||')
    ARCHIVE_FOLDER="$ARCHIVE_DIR/$DATE-$FOLDER_NAME"

    echo "[INFO] Branch changed, archiving previous run: $LAST_BRANCH"
    mkdir -p "$ARCHIVE_FOLDER"
    [ -f "$ISSUE_FILE" ] && cp "$ISSUE_FILE" "$ARCHIVE_FOLDER/"
    [ -f "$PROGRESS_FILE" ] && cp "$PROGRESS_FILE" "$ARCHIVE_FOLDER/"
    [ -f "$JEEVES_STATE_DIR/review.md" ] && cp "$JEEVES_STATE_DIR/review.md" "$ARCHIVE_FOLDER/"
    [ -f "$JEEVES_STATE_DIR/sonar-issues.json" ] && cp "$JEEVES_STATE_DIR/sonar-issues.json" "$ARCHIVE_FOLDER/"
    [ -f "$OPEN_QUESTIONS_FILE" ] && cp "$OPEN_QUESTIONS_FILE" "$ARCHIVE_FOLDER/"
    [ -f "$COVERAGE_FAILURES_FILE" ] && cp "$COVERAGE_FAILURES_FILE" "$ARCHIVE_FOLDER/"
    echo "[INFO] Archived to: $ARCHIVE_FOLDER"

    # Reset progress file for new run
    echo "# Jeeves Progress Log" > "$PROGRESS_FILE"
    echo "Started: $(date)" >> "$PROGRESS_FILE"
    echo "---" >> "$PROGRESS_FILE"
  fi
fi

# Track current branch
CURRENT_BRANCH=$(jq -r '.branchName // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
if [ -n "$CURRENT_BRANCH" ]; then
  mkdir -p "$JEEVES_STATE_DIR"
  echo "$CURRENT_BRANCH" > "$LAST_BRANCH_FILE"
  echo "[DEBUG] Tracking branch: $CURRENT_BRANCH"
fi

# Initialize progress file if it doesn't exist
if [ ! -f "$PROGRESS_FILE" ]; then
  echo "[INFO] Creating new progress file"
  echo "# Jeeves Progress Log" > "$PROGRESS_FILE"
  echo "Started: $(date)" >> "$PROGRESS_FILE"
  echo "---" >> "$PROGRESS_FILE"
fi

# Show summary
echo ""
echo "[INFO] Jeeves Summary:"
ISSUE_NUMBER=$(jq -r '.issue.number // .issueNumber // empty' "$ISSUE_FILE" 2>/dev/null || echo "")
DESIGN_DOC=$(jq -r '.designDocPath // .designDoc // empty' "$ISSUE_FILE" 2>/dev/null || echo "")
select_issue_phase

echo "       Issue: ${ISSUE_NUMBER:-<unknown>}"
echo "       Design doc: ${DESIGN_DOC:-<none>}"
if [ -n "$ISSUE_PR_NUMBER" ] && [ "$ISSUE_PR_NUMBER" != "null" ]; then
  echo "       PR: #$ISSUE_PR_NUMBER"
elif [ -n "$ISSUE_PR_URL" ] && [ "$ISSUE_PR_URL" != "null" ]; then
  echo "       PR: $ISSUE_PR_URL"
else
  echo "       PR: <none>"
fi
echo "       Status: implemented=$ISSUE_STATUS_IMPLEMENTED, prCreated=$ISSUE_STATUS_PR_CREATED, prDescriptionReady=$ISSUE_STATUS_PR_DESCRIPTION_READY, reviewClean=$ISSUE_STATUS_REVIEW_CLEAN, ciClean=$ISSUE_STATUS_CI_CLEAN, coverageClean=$ISSUE_STATUS_COVERAGE_CLEAN, coverageNeedsFix=$ISSUE_STATUS_COVERAGE_NEEDS_FIX, sonarClean=$ISSUE_STATUS_SONAR_CLEAN"
echo "       Phase: $ISSUE_PHASE"
echo ""

echo "Starting Jeeves - Max iterations: $MAX_ITERATIONS"
echo ""

LAST_PRINTED_PROMPT_KEY=""

metrics_write_run_start
debug_write_run_start

# Fast exit if already complete
select_issue_phase
if [ "$ISSUE_STATUS_IMPLEMENTED" = "true" ] && [ "$ISSUE_STATUS_PR_CREATED" = "true" ] && [ "$ISSUE_STATUS_PR_DESCRIPTION_READY" = "true" ] && [ "$ISSUE_STATUS_REVIEW_CLEAN" = "true" ] && [ "$ISSUE_STATUS_CI_CLEAN" = "true" ] && [ "$ISSUE_STATUS_COVERAGE_CLEAN" = "true" ] && [ "$ISSUE_STATUS_COVERAGE_NEEDS_FIX" != "true" ] && [ "$ISSUE_STATUS_SONAR_CLEAN" = "true" ]; then
  echo "╔═══════════════════════════════════════════════════════╗"
  echo "║           Jeeves completed all tasks!                  ║"
  echo "╚═══════════════════════════════════════════════════════╝"
  echo "Issue workflow is already marked complete."
  RUN_EXIT_REASON="already_complete"
  RUN_EXIT_ITERATION="0"
  exit 0
fi

for i in $(seq 1 $MAX_ITERATIONS); do
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  Jeeves Iteration $i of $MAX_ITERATIONS"
  echo "  Started: $(date)"
  echo "═══════════════════════════════════════════════════════"

  # Show current status
  select_issue_phase
  echo "[DEBUG] Phase: $ISSUE_PHASE"
  echo "[DEBUG] Issue status: implemented=$ISSUE_STATUS_IMPLEMENTED, prCreated=$ISSUE_STATUS_PR_CREATED, prDescriptionReady=$ISSUE_STATUS_PR_DESCRIPTION_READY, reviewClean=$ISSUE_STATUS_REVIEW_CLEAN, ciClean=$ISSUE_STATUS_CI_CLEAN, coverageClean=$ISSUE_STATUS_COVERAGE_CLEAN, coverageNeedsFix=$ISSUE_STATUS_COVERAGE_NEEDS_FIX, sonarClean=$ISSUE_STATUS_SONAR_CLEAN"

  echo "[DEBUG] Prompt file: $PROMPT_FILE"
  if [ ! -f "$PROMPT_FILE" ]; then
    echo "[ERROR] Prompt file not found: $PROMPT_FILE"
    exit 1
  fi

  # Optionally append extra instructions to the prompt (per-iteration).
  PROMPT_FILE_TO_USE="$PROMPT_FILE"
  PROMPT_KEY="$PROMPT_FILE"
  TMP_PROMPT_FILE=""

  if [ -n "$PROMPT_APPEND_FILE" ]; then
    APPEND_PATH="$PROMPT_APPEND_FILE"
    if [ ! -f "$APPEND_PATH" ] && [[ "$APPEND_PATH" != /* ]]; then
      if [ -f "$WORK_DIR/$APPEND_PATH" ]; then
        APPEND_PATH="$WORK_DIR/$APPEND_PATH"
      fi
    fi

    if [ -s "$APPEND_PATH" ]; then
      PROMPT_KEY="$PROMPT_FILE|$APPEND_PATH"
      TMP_PROMPT_FILE="$(mktemp "$JEEVES_STATE_DIR/.prompt.combined.XXXXXX")"
      cat "$PROMPT_FILE" > "$TMP_PROMPT_FILE"
      printf '\n' >> "$TMP_PROMPT_FILE"
      cat "$APPEND_PATH" >> "$TMP_PROMPT_FILE"
      PROMPT_FILE_TO_USE="$TMP_PROMPT_FILE"
    fi
  fi

		  if [ "$OUTPUT_MODE" != "stream" ] && [ "$PRINT_PROMPT" = "1" ] && [ "$PROMPT_KEY" != "$LAST_PRINTED_PROMPT_KEY" ]; then
		    echo ""
		    echo "----- Prompt ($PROMPT_FILE_TO_USE) -----"
		    cat "$PROMPT_FILE_TO_USE"
		    echo "----- End Prompt -----"
		    echo ""
		    LAST_PRINTED_PROMPT_KEY="$PROMPT_KEY"
		  fi

	  PHASE_AT_START="$ISSUE_PHASE"
	  DEBUG_PHASE_KEY="$(debug_phase_key "$PHASE_AT_START")"

	  metrics_write_iteration_start "$i"
	  debug_write_iteration_start "$i" "$DEBUG_PHASE_KEY"
	
	  # Run the agent with the jeeves prompt
	  echo "[DEBUG] Invoking agent runner ($RUNNER)..."
	  START_TIME=$(date +%s)
	  LAST_MESSAGE_FILE="$JEEVES_STATE_DIR/last-message.txt"
	  rm -f "$LAST_MESSAGE_FILE" 2>/dev/null || true
	  RUNNER_CALLS=0
	
	  if [ "$RUNNER" = "codex" ]; then
	    if [ "$OUTPUT_MODE" = "stream" ]; then
	      # In stream mode, write to both log file AND stderr for real-time viewing
	      rm -f "$LAST_RUN_LOG_FILE" 2>/dev/null || true
	      : > "$LAST_RUN_LOG_FILE"
	      if [ "$CODEX_DANGEROUS" = "1" ]; then
	        RUNNER_CALLS=$((RUNNER_CALLS + 1))
	        debug_write_runner_invoke "$i" "$DEBUG_PHASE_KEY" "$RUNNER_CALLS"
	        codex --ask-for-approval "$CODEX_APPROVAL_POLICY" exec --dangerously-bypass-approvals-and-sandbox -C "$WORK_DIR" --color never --output-last-message "$LAST_MESSAGE_FILE" - < "$PROMPT_FILE_TO_USE" 2>&1 | tee "$LAST_RUN_LOG_FILE" >(cat >&2) || true
	      else
	        RUNNER_CALLS=$((RUNNER_CALLS + 1))
	        debug_write_runner_invoke "$i" "$DEBUG_PHASE_KEY" "$RUNNER_CALLS"
	        codex --ask-for-approval "$CODEX_APPROVAL_POLICY" exec --sandbox "$CODEX_SANDBOX" -C "$WORK_DIR" --color never --output-last-message "$LAST_MESSAGE_FILE" - < "$PROMPT_FILE_TO_USE" 2>&1 | tee "$LAST_RUN_LOG_FILE" >(cat >&2) || true
	        if grep -qi "error running landlock" "$LAST_RUN_LOG_FILE"; then
	          {
	            echo ""
	            echo "[WARN] Codex sandbox failed (landlock). Retrying without sandbox."
	            echo "[WARN] To bypass the sandbox next time, set: JEEVES_CODEX_DANGEROUS=1"
	            echo ""
	          } | tee -a "$LAST_RUN_LOG_FILE" >(cat >&2)
	          RUNNER_CALLS=$((RUNNER_CALLS + 1))
	          debug_write_runner_invoke "$i" "$DEBUG_PHASE_KEY" "$RUNNER_CALLS"
	          codex --ask-for-approval "$CODEX_APPROVAL_POLICY" exec --dangerously-bypass-approvals-and-sandbox -C "$WORK_DIR" --color never --output-last-message "$LAST_MESSAGE_FILE" - < "$PROMPT_FILE_TO_USE" 2>&1 | tee -a "$LAST_RUN_LOG_FILE" >(cat >&2) || true
	        fi
	      fi
	    else
	      rm -f "$LAST_RUN_LOG_FILE" 2>/dev/null || true
	      : > "$LAST_RUN_LOG_FILE"
	
	      if [ "$CODEX_DANGEROUS" = "1" ]; then
	        RUNNER_CALLS=$((RUNNER_CALLS + 1))
	        debug_write_runner_invoke "$i" "$DEBUG_PHASE_KEY" "$RUNNER_CALLS"
	        codex --ask-for-approval "$CODEX_APPROVAL_POLICY" exec --dangerously-bypass-approvals-and-sandbox -C "$WORK_DIR" --color never --output-last-message "$LAST_MESSAGE_FILE" - < "$PROMPT_FILE_TO_USE" > "$LAST_RUN_LOG_FILE" 2>&1 || true
	      else
	        RUNNER_CALLS=$((RUNNER_CALLS + 1))
	        debug_write_runner_invoke "$i" "$DEBUG_PHASE_KEY" "$RUNNER_CALLS"
	        codex --ask-for-approval "$CODEX_APPROVAL_POLICY" exec --sandbox "$CODEX_SANDBOX" -C "$WORK_DIR" --color never --output-last-message "$LAST_MESSAGE_FILE" - < "$PROMPT_FILE_TO_USE" > "$LAST_RUN_LOG_FILE" 2>&1 || true
	        if grep -qi "error running landlock" "$LAST_RUN_LOG_FILE"; then
	          echo ""
	          echo "[WARN] Codex sandbox failed (landlock). Retrying without sandbox."
	          echo "[WARN] To bypass the sandbox next time, set: JEEVES_CODEX_DANGEROUS=1"
          echo ""
	
	          echo "" >> "$LAST_RUN_LOG_FILE"
	          echo "[WARN] Codex sandbox failed (landlock). Retrying without sandbox." >> "$LAST_RUN_LOG_FILE"
	          RUNNER_CALLS=$((RUNNER_CALLS + 1))
	          debug_write_runner_invoke "$i" "$DEBUG_PHASE_KEY" "$RUNNER_CALLS"
	          codex --ask-for-approval "$CODEX_APPROVAL_POLICY" exec --dangerously-bypass-approvals-and-sandbox -C "$WORK_DIR" --color never --output-last-message "$LAST_MESSAGE_FILE" - < "$PROMPT_FILE_TO_USE" >> "$LAST_RUN_LOG_FILE" 2>&1 || true
	        fi
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
	      RUNNER_CALLS=$((RUNNER_CALLS + 1))
	      debug_write_runner_invoke "$i" "$DEBUG_PHASE_KEY" "$RUNNER_CALLS"
	      if [ -n "$SANDBOX_VALUE" ]; then
	        IS_SANDBOX="$SANDBOX_VALUE" "${CLAUDE_ARGS[@]}" "$(cat "$PROMPT_FILE_TO_USE")" 2>&1 | tee "$LAST_RUN_LOG_FILE" >(cat >&2) || true
	      else
	        "${CLAUDE_ARGS[@]}" "$(cat "$PROMPT_FILE_TO_USE")" 2>&1 | tee "$LAST_RUN_LOG_FILE" >(cat >&2) || true
	      fi
	    else
	      rm -f "$LAST_RUN_LOG_FILE" 2>/dev/null || true
	      : > "$LAST_RUN_LOG_FILE"
	      RUNNER_CALLS=$((RUNNER_CALLS + 1))
	      debug_write_runner_invoke "$i" "$DEBUG_PHASE_KEY" "$RUNNER_CALLS"
	      if [ -n "$SANDBOX_VALUE" ]; then
	        IS_SANDBOX="$SANDBOX_VALUE" "${CLAUDE_ARGS[@]}" "$(cat "$PROMPT_FILE_TO_USE")" > "$LAST_RUN_LOG_FILE" 2>&1 || true
	      else
	        "${CLAUDE_ARGS[@]}" "$(cat "$PROMPT_FILE_TO_USE")" > "$LAST_RUN_LOG_FILE" 2>&1 || true
	      fi
    fi
	  elif [ "$RUNNER" = "opencode" ]; then
	    # Build opencode command with non-interactive run
	    OPENCODE_CMD="opencode"
	    if [ "$OUTPUT_MODE" = "stream" ]; then
	      # In stream mode, write to both log file AND stderr for real-time viewing
	      rm -f "$LAST_RUN_LOG_FILE" 2>/dev/null || true
	      : > "$LAST_RUN_LOG_FILE"
	      RUNNER_CALLS=$((RUNNER_CALLS + 1))
	      debug_write_runner_invoke "$i" "$DEBUG_PHASE_KEY" "$RUNNER_CALLS"
	      (cd "$WORK_DIR" && $OPENCODE_CMD run "$(cat "$PROMPT_FILE_TO_USE")" 2>&1) | tee "$LAST_RUN_LOG_FILE" >(cat >&2) || true
	    else
	      rm -f "$LAST_RUN_LOG_FILE" 2>/dev/null || true
	      : > "$LAST_RUN_LOG_FILE"
	      RUNNER_CALLS=$((RUNNER_CALLS + 1))
	      debug_write_runner_invoke "$i" "$DEBUG_PHASE_KEY" "$RUNNER_CALLS"
	      (cd "$WORK_DIR" && $OPENCODE_CMD run "$(cat "$PROMPT_FILE_TO_USE")" > "$LAST_RUN_LOG_FILE" 2>&1) || true
	    fi
  elif [ "$RUNNER" = "sdk" ]; then
    # SDK runner using claude-agent-sdk (Python)
    rm -f "$LAST_RUN_LOG_FILE" 2>/dev/null || true
    : > "$LAST_RUN_LOG_FILE"
    RUNNER_CALLS=$((RUNNER_CALLS + 1))
    debug_write_runner_invoke "$i" "$DEBUG_PHASE_KEY" "$RUNNER_CALLS"

    SDK_RUNNER_CMD="$SDK_PYTHON -m jeeves.runner.sdk_runner"
    SDK_ARGS=(
      --prompt "$PROMPT_FILE_TO_USE"
      --output "$SDK_OUTPUT_FILE"
      --text-output "$LAST_RUN_LOG_FILE"
      --work-dir "$WORK_DIR"
      --state-dir "$JEEVES_STATE_DIR"
    )

    # Set PYTHONPATH to prioritize Jeeves installation directory
    # This prevents Python from importing wrong jeeves module if work dir has one
    if [ "$OUTPUT_MODE" = "stream" ]; then
      # In stream mode, tee output to stderr for real-time viewing
      if [ -n "$SANDBOX_VALUE" ]; then
        (cd "$WORK_DIR" && PYTHONPATH="$SCRIPT_DIR" IS_SANDBOX="$SANDBOX_VALUE" $SDK_RUNNER_CMD "${SDK_ARGS[@]}" 2>&1) | tee -a "$LAST_RUN_LOG_FILE" >(cat >&2) || true
      else
        (cd "$WORK_DIR" && PYTHONPATH="$SCRIPT_DIR" $SDK_RUNNER_CMD "${SDK_ARGS[@]}" 2>&1) | tee -a "$LAST_RUN_LOG_FILE" >(cat >&2) || true
      fi
    else
      if [ -n "$SANDBOX_VALUE" ]; then
        (cd "$WORK_DIR" && PYTHONPATH="$SCRIPT_DIR" IS_SANDBOX="$SANDBOX_VALUE" $SDK_RUNNER_CMD "${SDK_ARGS[@]}" >> "$LAST_RUN_LOG_FILE" 2>&1) || true
      else
        (cd "$WORK_DIR" && PYTHONPATH="$SCRIPT_DIR" $SDK_RUNNER_CMD "${SDK_ARGS[@]}" >> "$LAST_RUN_LOG_FILE" 2>&1) || true
      fi
    fi
  else
    echo "[ERROR] Unsupported runner: $RUNNER"
    exit 1
  fi

  # Clean up any temp prompt file created for this iteration.
  if [ -n "$TMP_PROMPT_FILE" ] && [ -f "$TMP_PROMPT_FILE" ]; then
    rm -f "$TMP_PROMPT_FILE" 2>/dev/null || true
  fi

		  END_TIME=$(date +%s)
		  DURATION=$((END_TIME - START_TIME))

		  RUNNER_LOG_BYTES="0"
		  RUNNER_LOG_LINES="0"
		  if [ -f "$LAST_RUN_LOG_FILE" ]; then
		    RUNNER_LOG_BYTES="$(wc -c < "$LAST_RUN_LOG_FILE" 2>/dev/null | tr -d '[:space:]' || echo "0")"
		    RUNNER_LOG_LINES="$(wc -l < "$LAST_RUN_LOG_FILE" 2>/dev/null | tr -d '[:space:]' || echo "0")"
		  fi

		  LAST_MESSAGE_BYTES="0"
		  if [ -f "$LAST_MESSAGE_FILE" ]; then
		    LAST_MESSAGE_BYTES="$(wc -c < "$LAST_MESSAGE_FILE" 2>/dev/null | tr -d '[:space:]' || echo "0")"
		  fi

		  OUTPUT_BYTES="$RUNNER_LOG_BYTES"
		  if [ "$OUTPUT_BYTES" = "0" ] && [ "$LAST_MESSAGE_BYTES" != "0" ]; then
		    OUTPUT_BYTES="$LAST_MESSAGE_BYTES"
		  fi

		  echo ""
		  echo "[DEBUG] Agent finished in ${DURATION}s"
		  echo "[DEBUG] Output length: ${OUTPUT_BYTES} bytes"

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

	  EXEC_COUNT="0"
	  FILE_UPDATE_COUNT="0"
		  if [ -f "$LAST_RUN_LOG_FILE" ]; then
		    EXEC_COUNT="$(grep -cE '^exec([ :]|$)' "$LAST_RUN_LOG_FILE" 2>/dev/null || true)"
		    FILE_UPDATE_COUNT="$(grep -c '^file update:' "$LAST_RUN_LOG_FILE" 2>/dev/null || true)"
		  fi
		  debug_write_log_lines "$i" "$DEBUG_PHASE_KEY" "$LAST_RUN_LOG_FILE"

		  # Archive per-iteration artifacts for later analysis.
		  if [ -n "${RUN_ITERATIONS_DIR:-}" ] && [ -d "${RUN_ITERATIONS_DIR:-}" ]; then
		    [ -f "$LAST_RUN_LOG_FILE" ] && cp "$LAST_RUN_LOG_FILE" "$RUN_ITERATIONS_DIR/iter-${i}.last-run.log" 2>/dev/null || true
		    [ -f "$LAST_MESSAGE_FILE" ] && cp "$LAST_MESSAGE_FILE" "$RUN_ITERATIONS_DIR/iter-${i}.last-message.txt" 2>/dev/null || true
		  fi
		
			  # Check for completion signal
			  PROMISE_COMPLETE="false"
	  if ([ -f "$LAST_MESSAGE_FILE" ] && grep -q "<promise>COMPLETE</promise>" "$LAST_MESSAGE_FILE") \
	    || ([ -f "$LAST_RUN_LOG_FILE" ] && grep -q "<promise>COMPLETE</promise>" "$LAST_RUN_LOG_FILE"); then
	    PROMISE_COMPLETE="true"
	  fi

	  if [ "$PROMISE_COMPLETE" = "true" ]; then
	    # Refresh status for metrics without printing extra output.
	    select_issue_phase

	    metrics_write_iteration_end "$i" "$DURATION" "$OUTPUT_BYTES" "$RUNNER_CALLS" "$RUNNER_LOG_BYTES" "$RUNNER_LOG_LINES" "$LAST_MESSAGE_BYTES" "$EXEC_COUNT" "$FILE_UPDATE_COUNT" "true" "promise" "$PHASE_AT_START"
	    debug_write_iteration_end "$i" "$DEBUG_PHASE_KEY" "$DURATION" "$OUTPUT_BYTES" "$RUNNER_CALLS" "$RUNNER_LOG_BYTES" "$RUNNER_LOG_LINES" "$LAST_MESSAGE_BYTES" "$EXEC_COUNT" "$FILE_UPDATE_COUNT" "true" "promise"

	    echo ""
	    echo "╔═══════════════════════════════════════════════════════╗"
	    echo "║           Jeeves completed all tasks!                  ║"
	    echo "╚═══════════════════════════════════════════════════════╝"
	    echo "Completed at iteration $i of $MAX_ITERATIONS"
	    RUN_EXIT_REASON="complete_promise"
	    RUN_EXIT_ITERATION="$i"
	    exit 0
	  fi
	
	  # Stop condition based on config state (backup to promise token)
	  ITERATION_COMPLETE="false"
	  select_issue_phase
	  echo "[DEBUG] Issue status: implemented=$ISSUE_STATUS_IMPLEMENTED, prCreated=$ISSUE_STATUS_PR_CREATED, prDescriptionReady=$ISSUE_STATUS_PR_DESCRIPTION_READY, reviewClean=$ISSUE_STATUS_REVIEW_CLEAN, ciClean=$ISSUE_STATUS_CI_CLEAN, coverageClean=$ISSUE_STATUS_COVERAGE_CLEAN, coverageNeedsFix=$ISSUE_STATUS_COVERAGE_NEEDS_FIX, sonarClean=$ISSUE_STATUS_SONAR_CLEAN"

	  if [ "$ISSUE_STATUS_IMPLEMENTED" = "true" ] && [ "$ISSUE_STATUS_PR_CREATED" = "true" ] && [ "$ISSUE_STATUS_PR_DESCRIPTION_READY" = "true" ] && [ "$ISSUE_STATUS_REVIEW_CLEAN" = "true" ] && [ "$ISSUE_STATUS_CI_CLEAN" = "true" ] && [ "$ISSUE_STATUS_COVERAGE_CLEAN" = "true" ] && [ "$ISSUE_STATUS_COVERAGE_NEEDS_FIX" != "true" ] && [ "$ISSUE_STATUS_SONAR_CLEAN" = "true" ]; then
	    ITERATION_COMPLETE="true"
	  fi

	  metrics_write_iteration_end "$i" "$DURATION" "$OUTPUT_BYTES" "$RUNNER_CALLS" "$RUNNER_LOG_BYTES" "$RUNNER_LOG_LINES" "$LAST_MESSAGE_BYTES" "$EXEC_COUNT" "$FILE_UPDATE_COUNT" "$ITERATION_COMPLETE" "$(if [ "$ITERATION_COMPLETE" = "true" ]; then echo "config"; else echo ""; fi)" "$PHASE_AT_START"
	  debug_write_iteration_end "$i" "$DEBUG_PHASE_KEY" "$DURATION" "$OUTPUT_BYTES" "$RUNNER_CALLS" "$RUNNER_LOG_BYTES" "$RUNNER_LOG_LINES" "$LAST_MESSAGE_BYTES" "$EXEC_COUNT" "$FILE_UPDATE_COUNT" "$ITERATION_COMPLETE" "$(if [ "$ITERATION_COMPLETE" = "true" ]; then echo "config"; else echo ""; fi)"

	  if [ "$ITERATION_COMPLETE" = "true" ]; then
	    echo ""
	    echo "╔═══════════════════════════════════════════════════════╗"
	    echo "║           Jeeves completed all tasks!                  ║"
	    echo "╚═══════════════════════════════════════════════════════╝"
	    echo "Completed at iteration $i of $MAX_ITERATIONS"
	    RUN_EXIT_REASON="complete_config"
	    RUN_EXIT_ITERATION="$i"
	    exit 0
	  fi
	
	  echo "[INFO] Iteration $i complete. Continuing..."
	  sleep 2
	done

echo ""
echo "╔═══════════════════════════════════════════════════════╗"
echo "║  Jeeves reached max iterations without completing      ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo "Max iterations: $MAX_ITERATIONS"
echo "Check $PROGRESS_FILE for status."
RUN_EXIT_REASON="max_iterations"
RUN_EXIT_ITERATION="$MAX_ITERATIONS"
exit 1
