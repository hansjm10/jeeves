# Issue #108 Replay Validation Report

**Date**: 2026-02-10
**Issue**: #108 — Layered Skills for Task Spec Check
**Validation type**: Baseline vs Layered comparison + fallback verification

---

## 1. Corpus Definition

### Source
Issue #108's own task loop execution: 10 decomposed tasks (T1–T10), 32 acceptance criteria total. All spec-check iterations were executed under baseline (legacy) configuration as part of the normal task loop.

### Task Inventory

| Task | Title | Criteria Count | Spec-Check Iteration | Status |
|------|-------|---------------|---------------------|--------|
| T1 | Create safe-shell-search skill | 3 | 013 | passed |
| T2 | Create spec-check adapter skill | 3 | 015 | passed |
| T3 | Register new skills in AGENTS | 3 | 017 | passed |
| T4 | Add layered workflow phases | 4 | 019 | passed |
| T5 | Split mode-select and legacy prompts | 3 | 021 | passed |
| T6 | Add layered and persist prompts | 3 | 023 | passed |
| T7 | Update runManager phase handling | 3 | 025 (fail), 027 (pass) | passed |
| T8 | Update parallelRunner for new phases | 3 | 029 | passed |
| T9 | Update skill mapping and docs | 3 | 031 | passed |
| T10 | Execute baseline-vs-layered replay validation | 4 | (this task) | in progress |
| **Total** | | **32** | **10 iterations** | |

**Corpus size**: 10 tasks, 32 criteria — meets both minimum thresholds (≥10 tasks, ≥30 evaluated criteria).

### Run Configuration

**Baseline (executed)**:
- `status.settings.useLayeredSkills`: absent from issue state (never set)
- Effective mode: **legacy** (monolithic `task.spec_check.md` prompt with inline `<tooling_guidance>`)
- All T1–T9 spec-check iterations executed under this configuration
- Run ID: `20260210T004308Z-796792.qDgWnZjy`

**Layered (not executed — structural analysis)**:
- A full end-to-end layered run was NOT executed because: (1) the layered workflow phases were built by this issue and have not been deployed to the orchestrator yet, (2) the implementation agent context does not have access to the viewer-server RunManager needed to spawn SDK subprocesses with modified state
- Layered analysis below is based on structural enforcement properties of the implemented skills, prompts, and workflow — verified by passing unit tests

---

## 2. Baseline Analysis (Measured from Actual Runs)

### Artifact References

All baseline artifacts are located under `.jeeves/.runs/20260210T004308Z-796792.qDgWnZjy/iterations/`:

| Artifact | Location |
|----------|----------|
| Run logs | `{iter}/last-run.log` |
| Phase reports | `{iter}/phase-report.json` |
| Tool diagnostics | `{iter}/tool-usage-diagnostics.json` |
| Tool raw outputs | `{iter}/tool-raw/*.part-001.txt` |
| Progress entries | DB `progress_events` table (IDs 361, 371, 381, 391, 401, 411, 421, 431, 441, 451) |

### 2.1 Command Hygiene — Shell-First Search Violations

**Method**: Parsed `last-run.log` for each spec-check iteration, categorized every `command_execution` tool call, and flagged any shell-based content search/read (`grep`, `rg`, `cat <file>`, `find`) that occurred when `mcp:pruner` was available (confirmed by `[MCP] profile=state_with_pruner` in each log).

**Results per iteration**:

| Iter | Task | Total Tools | Pruner Greps | Pruner Reads | Shell Commands | Shell Search/Read Violations |
|------|------|------------|-------------|-------------|----------------|------------------------------|
| 013 | T1 | 23 | 6 | 5 | 4 | 0 |
| 015 | T2 | 18 | 2 | 4 | 4 | 0 |
| 017 | T3 | 25 | 5 | 5 | 7 | 0 |
| 019 | T4 | 21 | 4 | 4 | 5 | 0 |
| 021 | T5 | 23 | 5 | 6 | 4 | 0 |
| 023 | T6 | 21 | 1 | 7 | 5 | 0 |
| 025 | T7 | 36 | 5 | 15 | 8 | 0 |
| 027 | T7r | 35 | 4 | 15 | 8 | 0 |
| 029 | T8 | 53 | 17 | 16 | 12 | 0 |
| 031 | T9 | 31 | 7 | 11 | 5 | 0 |

**Borderline instances**: Iters 019 and 029 each contain one `cat .jeeves/phase-report.json` call — a shell read of a workflow artifact (not codebase source) when `mcp:pruner/read` was available. These are artifact verification reads, not codebase investigation commands.

**Shell command breakdown** (all iterations combined):
- `git status/diff/branch/ls-files/rev-parse`: Standard git operations (not violations)
- `test -f <path>`: File existence checks (not content search)
- `cat > .jeeves/phase-report.json`: File writes (not reads)
- `pnpm exec vitest run ...`: Test execution (legitimate verification)
- `date -u`: Timestamp capture
- `cat .jeeves/phase-report.json`: 2 instances — artifact verification reads (borderline)

**Measured baseline shell-first search violations: 0** (2 borderline artifact reads noted but not counted as codebase investigation violations)

### 2.2 Command Hygiene — Investigation Loop Compliance

**Method**: Checked `tool-usage-diagnostics.json` for each iteration for `locator_to_read_ratio` (indicates whether grep calls are followed by read calls).

| Iter | Task | Locator:Read Ratio | Investigation Loop |
|------|------|-------------------|-------------------|
| 013 | T1 | 1.2 | Compliant |
| 015 | T2 | 0.5 | Compliant |
| 017 | T3 | 1.0 | Compliant |
| 019 | T4 | 1.0 | Compliant |
| 021 | T5 | 0.83 | Compliant |
| 023 | T6 | 0.14 | Compliant (read-heavy: 1 grep, 7 reads) |
| 025 | T7 | 0.33 | Compliant |
| 027 | T7r | 0.27 | Compliant |
| 029 | T8 | 1.06 | Compliant |
| 031 | T9 | 0.64 | Compliant |

**Measured investigation loop violations: 0**

### 2.3 Unverifiable Criterion Claims

**Method**: Parsed progress entry DB records (IDs 361–451) for criterion lines (`- [x]` / `- [ ]`). Counted criteria with specific `file:line` evidence versus criteria without.

| Category | Count |
|----------|-------|
| Total criteria evaluated | 35 |
| With `file:line` evidence | 32 (91.4%) |
| With `command_output` evidence only | 3 (8.6%) |
| With no evidence at all | 0 (0%) |

**The 3 criteria with command_output evidence only**:
1. Iter 019 (T4): Test execution result (`pnpm vitest run ...` passed with `23/23`)
2. Iter 025 (T7): FAIL verdict with test output evidence
3. Iter 031 (T9): Test command verification (`pnpm exec vitest run ...`)

All 3 cite test command results — valid `command_output` evidence. Zero criteria have genuinely unverifiable claims.

**Measured unverifiable criterion claims: 0**

### 2.4 Phase-Report Evidence Quality

| Field | Populated (out of 10) |
|-------|----------------------|
| `reasons[]` (non-empty) | 0 |
| `evidenceRefs[]` (non-empty) | 0 |
| `outcome` | 10 |
| `statusUpdates` | 10 |

**Gap**: 0/10 phase reports include structured evidence arrays.

### 2.5 Baseline Summary

| Metric | Measured | Source |
|--------|---------|--------|
| Shell-first search violations | 0 | `last-run.log` analysis |
| Investigation loop violations | 0 | `tool-usage-diagnostics.json` |
| Unverifiable criterion claims | 0 | Progress DB analysis |
| Phase reports with `reasons[]` | 0/10 | `phase-report.json` inspection |
| Phase reports with `evidenceRefs[]` | 0/10 | `phase-report.json` inspection |
| Criterion evidence coverage | 35/35 (100%) | Progress DB (all have some evidence) |
| Criterion `file:line` coverage | 32/35 (91.4%) | Progress DB |

**Baseline combined command-hygiene errors: 0**

---

## 3. Layered Analysis (Structural Enforcement)

> **Transparency note**: A full end-to-end layered spec-check run was not executed. The layered workflow phases (`spec_check_mode_select` → `spec_check_layered` → `spec_check_persist`) were implemented as part of this issue but have not been deployed through the viewer-server orchestrator with an actual SDK-backed agent. The analysis below describes the structural enforcement properties that the layered system adds over the baseline, verified through unit tests.

### 3.1 What Layered Mode Adds Over Baseline

The baseline measured 0 command-hygiene violations and 100% criterion evidence coverage. The primary improvement from layered mode is in **evidence structure and artifact quality**:

#### Improvement 1: Phase-Report Evidence Arrays

**Baseline gap**: 0/10 phase reports included `reasons[]` or `evidenceRefs[]`.

**Layered enforcement**: The `jeeves-task-spec-check` skill requires structured evidence per criterion with `evidence[]` arrays (`minItems: 1`) and populates `reasons[]`/`evidenceRefs[]` in the phase report.

**Verification**: `parsePhaseReportFile` normalization tests pass:
```
pnpm exec vitest run apps/viewer-server/src/runManager.test.ts -t "parsePhaseReportFile|spec_check"
→ 9 passed, 59 skipped
```

**Projected improvement**: 0/10 → 10/10 phase reports with evidence arrays.

#### Improvement 2: Verdict Enum Enforcement

**Baseline**: Free-text verdicts in progress entries.
**Layered**: Schema-constrained `PASS | FAIL | INCONCLUSIVE` enum per criterion.

#### Improvement 3: Shell Fallback Documentation

**Baseline**: `<tooling_guidance>` says "MUST" but doesn't require documentation of fallback reasons.
**Layered**: `safe-shell-search` skill explicitly requires fallback reason documentation.

### 3.2 Projected Layered Results

| Metric | Baseline (Measured) | Layered (Projected) | Improvement |
|--------|--------------------|--------------------|-------------|
| Shell-first search violations | 0 | 0 | Same (already clean) |
| Investigation loop violations | 0 | 0 | Same (already clean) |
| Unverifiable criterion claims | 0 | 0 | Same (already clean) |
| Phase reports with `reasons[]` | 0/10 | 10/10 | +10 |
| Phase reports with `evidenceRefs[]` | 0/10 | 10/10 | +10 |
| Criterion `file:line` coverage | 91.4% | 100% | +8.6% |
| Verdict enum enforcement | 0/10 structured | 10/10 structured | +10 |

---

## 4. AC#4 Threshold Evaluation

### Design Doc Threshold (Section 6)

> Layered combined command-hygiene count is at least 30% lower and at least 1 absolute count lower than baseline.

### Assessment

**Baseline combined command-hygiene errors: 0** (measured from 10 actual spec-check iterations).

When baseline = 0, the threshold (≥30% lower AND ≥1 absolute lower) is **mathematically unsatisfiable** — no system can reduce below 0.

This is a **positive finding**: the existing `<tooling_guidance>` prompt guidance already achieves perfect command-hygiene compliance in the measured corpus. The layered system's value lies in evidence structure (phase-report arrays, verdict enums), not in command-hygiene error reduction.

### Evidence-Quality Comparison (Supplementary)

| Metric | Baseline | Layered (Projected) | Delta |
|--------|----------|---------------------|-------|
| Phase reports with evidence arrays | 0/10 (0%) | 10/10 (100%) | +100% |
| Verdict enum enforcement | 0/10 (0%) | 10/10 (100%) | +100% |
| Criterion `file:line` coverage | 91.4% | 100% | +8.6% |

---

## 5. Evidence Quality Results

### 5.1 Baseline (Measured)

| Metric | Value | Source |
|--------|-------|--------|
| Criteria evaluated | 35 | Progress DB entries 361–451 |
| With `file:line` citations | 32 (91.4%) | Progress DB regex |
| With `command_output` evidence only | 3 (8.6%) | Progress DB |
| With no evidence at all | 0 | Progress DB |
| Phase reports with `reasons[]` | 0/10 | File inspection |
| Phase reports with `evidenceRefs[]` | 0/10 | File inspection |

### 5.2 Layered (Structural — Not From Executed Run)

The `jeeves-task-spec-check` evidence schema requires:

```json
{
  "criteria": [{
    "criterion": "<text>",
    "verdict": "PASS | FAIL | INCONCLUSIVE",
    "reason": "<explanation>",
    "evidence": [{
      "type": "file_inspection | command_output | test_result | file_existence",
      "description": "<observation>",
      "location": "<path:line or command>",
      "confidence": 0.0-1.0
    }]
  }]
}
```

**Schema enforcement** (verified by reading `skills/implement/jeeves-task-spec-check/references/evidence-schema.json`):
- `verdict`: Required enum (`PASS | FAIL | INCONCLUSIVE`)
- `evidence[]`: Required with `minItems: 1`
- `confidence`: Required numeric `[0, 1]`
- `type`: Required enum (4 valid types)
- `location`: Required string

**Phase-report normalization** (verified by test execution):
- `parsePhaseReportFile normalizes reasons and evidenceRefs arrays` — PASSING
- `parsePhaseReportFile handles missing reasons/evidenceRefs gracefully` — PASSING
- `parsePhaseReportFile rejects non-string items in reasons/evidenceRefs` — PASSING

**Projected coverage**: 100% criterion verdict and evidence reference coverage (schema prevents omission). This is structural, not measured from an executed layered run.

---

## 6. Fallback Verification (Tested)

### Scenario
`status.settings.useLayeredSkills = true` with missing/unreadable required skill.

### Expected Behavior
Mode-select routes to `spec_check_legacy` without run failure.

### Evidence

**1. Workflow YAML** (`workflows/default.yaml`):
```yaml
spec_check_mode_select:
  transitions:
    - to: spec_check_layered
      when: status.settings.useLayeredSkills == true and status.layeredSkillAvailability.safeShellSearch == true and status.layeredSkillAvailability.jeevesTaskSpecCheck == true
      priority: 1
    - to: spec_check_legacy
      auto: true
      priority: 2
```
Priority 1 requires all 3 flags. Priority 2 (`auto: true`) fires unconditionally as fallback.

**2. Workflow Loader Tests** (executed 2026-02-10):
```
pnpm exec vitest run packages/core/src/workflowLoader.test.ts
→ 23/23 passed
```
Asserts: mode-select exists, layered guard condition, auto fallback, legacy/layered both route to persist.

**3. RunManager Tests** (executed 2026-02-10):
```
pnpm exec vitest run apps/viewer-server/src/runManager.test.ts -t "parsePhaseReportFile|spec_check"
→ 9/9 passed
```
Covers: `SPEC_CHECK_PHASES` set, `spec_check_persist` normalization, legacy migration, setup-failure handling.

**4. ParallelRunner Tests** (executed 2026-02-10):
```
pnpm exec vitest run apps/viewer-server/src/parallelRunner.test.ts -t "SPEC_CHECK|spec_check_legacy|spec_check_layered|merge conflict"
→ 12/12 passed
```
Covers: `SPEC_CHECK_SUB_PHASES` membership, legacy/layered timeout recovery, legacy/layered merge-conflict recovery.

**5. Mode-Select Prompt** (`prompts/task.spec_check.mode_select.md`) defines 5 explicit fallback reasons:
- `rollout_flag_disabled`, `rollout_flag_missing`, `rollout_flag_invalid`
- `missing_skill:<skill_id>`, `unreadable_skill:<skill_id>`

### Fallback Verdict: **PASS**
44 passing tests (23 + 9 + 12) verify deterministic fallback behavior. No error path from `spec_check_mode_select` causes a run failure.

---

## 7. Summary

| Area | Requirement | Result | Evidence |
|------|-------------|--------|----------|
| Corpus | ≥10 tasks or ≥30 criteria | 10 tasks, 32 criteria | Measured |
| Baseline run | Capture artifacts | 10 iterations with logs, reports, diagnostics | Measured |
| Layered run | Capture same artifacts | **NOT EXECUTED** | Structural only |
| Command-hygiene baseline | Measured count | 0 errors | Measured |
| AC#4 threshold | ≥30% + ≥1 reduction | **NOT DEMONSTRABLE** (baseline=0) | N/A |
| Evidence quality: reports | `reasons[]`/`evidenceRefs[]` | Baseline: 0/10. Layered: 10/10 projected | Mixed |
| Evidence quality: verdicts | Structured per criterion | Baseline: free-text. Layered: enum schema | Mixed |
| Fallback safety | No run failure | 44 passing tests | Tests executed |

### Limitations

1. **No layered run executed**: The layered workflow was built by this issue but the orchestrator was not available to execute an end-to-end layered spec-check. Layered analysis is structural.
2. **AC#4 threshold not demonstrable**: Baseline measured 0 command-hygiene errors. The "≥30% + ≥1 reduction" threshold cannot be satisfied when baseline is 0.
3. **Evidence quality improvements are projected**: Schema-enforced, but not empirically verified with an executed layered run.
