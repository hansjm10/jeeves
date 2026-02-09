# Design: AgentDiet-style Reflection Gating for Trajectory Reduction

**Issue**: #119
**Status**: Draft
**Feature Types**: Primary: Research/Enhancement, Secondary: None

---

## 1. Scope

### Problem
The current trajectory reduction system (#113) uses deterministic keyword-regex heuristics to categorize memory entries into the `ActiveContextSnapshot`. A memory entry containing "error" is classified as a blocker even if it says "no error found." There is no semantic understanding, no consolidation of related items, and no ability to assess whether an entry is still relevant to the current objective.

### Goals
- [ ] Replace keyword-regex categorization with Haiku-based semantic categorization of DB memory entries
- [ ] Consolidate semantically-similar items (e.g. "3 failed tests" + "test suite broken" = one blocker)
- [ ] Produce higher-quality `ActiveContextSnapshot` with fewer false positives and better relevance ranking
- [ ] Measure net token savings and categorization accuracy vs. deterministic baseline

### Non-Goals
- No production rollout gating or feature flags (single-user system)
- No replacement of #113 artifacts (`active-context.json`, `retired-trajectory.jsonl`) — schema unchanged
- No mid-session trajectory compression (AgentDiet's original use case)
- No progress log compression (DB-backed progress events are canonical)
- No cross-model benchmarking harness

### Boundaries
- **In scope**: Semantic categorization of memory entries at iteration boundary, gating formula, Haiku integration in viewer-server, evaluation harness, design for retired trajectory re-injection
- **Out of scope**: Adaptive context controller (#114), prompt template compression, runner-side changes

---

## 2. Background: AgentDiet → Jeeves Mapping

### AgentDiet Algorithm (Paper: arXiv:2509.23586)

AgentDiet compresses growing in-session trajectory by:
1. At step `s`, targeting step `s-a` for compression (delay `a=2`)
2. Building a context window of `a+b+1` steps (~4 steps) around the target
3. Calling a cheap reflection model (GPT-4o mini) to rewrite the target step, replacing waste with `"...(summary)"` placeholders
4. Applying the reduction only if both the original exceeds `θ=500` tokens AND savings exceed `θ` tokens

Results: ~40% input token savings, ~21-30% net cost reduction, no pass rate degradation.

### Architecture Mismatch

AgentDiet compresses **mid-session trajectory** (tool outputs growing within one context window). Jeeves already solves this differently — each iteration is a **fresh context window** via the Ralph Wiggum pattern. There is no growing in-session trajectory to compress.

### Where Reflection Fits Jeeves

The value is at the **iteration boundary** in `computeTrajectoryReduction()`. Today this function:
1. Reads memory entries from DB (`listMemoryEntriesFromDb`)
2. Categorizes via keyword regex (`isLikelyBlocker`, `isLikelyHypothesis`, etc.)
3. Deduplicates via string comparison (`toComparableKey`)
4. Writes `ActiveContextSnapshot`

Step 2 is the weak link. Haiku replaces it with semantic understanding.

### Adapted Parameters

| AgentDiet | Jeeves Equivalent | Value | Rationale |
|-----------|-------------------|-------|-----------|
| `a` (delay) | `iteration_delay` | 1 | Reflect on iteration N-1 artifacts, never current |
| `b` (backward context) | `lookback_iterations` | 2 | Include 2 prior snapshots for temporal context |
| `θ` (token threshold) | `min_snapshot_tokens` | 400 | Skip reflection if snapshot < 400 tokens |
| — | `min_savings_tokens` | 100 | Only apply if reflection saves > 100 tokens |

---

## 3. Interfaces

### No new external interfaces

The reflection is internal to `computeTrajectoryReduction()`. No new API endpoints, events, or user-facing changes.

The output schema (`ActiveContextSnapshot`, `RetiredTrajectoryRecord`, `TrajectoryReductionDiagnostics`) remains unchanged.

### New Diagnostic Fields

Add to `TrajectoryReductionDiagnostics`:

| Field | Type | Description |
|-------|------|-------------|
| `reflection_used` | `boolean` | Whether Haiku reflection was invoked |
| `reflection_input_tokens` | `number \| null` | Tokens sent to Haiku |
| `reflection_output_tokens` | `number \| null` | Tokens received from Haiku |
| `reflection_latency_ms` | `number \| null` | Wall-clock time for Haiku call |
| `reflection_skipped_reason` | `string \| null` | Why reflection was skipped (e.g. "below_threshold", "api_error") |

---

## 4. Data

### Schema Changes

No DB schema changes. The `issue_memory` table and `MemoryEntry` type are unchanged.

The only change is to `TrajectoryReductionDiagnostics` (a JSON artifact, not a DB table) — see diagnostic fields above.

### Artifacts

| Artifact | Location | On Success | On Failure |
|----------|----------|------------|------------|
| `active-context.json` | `.jeeves/issues/{o}/{r}/{n}/` | Written with Haiku-categorized snapshot | Written with deterministic fallback |
| `retired-trajectory.jsonl` | Same | Unchanged behavior | Unchanged behavior |
| `trajectory-reduction.json` | Same | Includes reflection diagnostics | Includes `reflection_skipped_reason` |

---

## 5. Algorithm

### Reflection Flow

```
computeTrajectoryReduction()
    │
    ├─ 1. Load memory entries from DB
    ├─ 2. Load previous snapshot (iteration N-1)
    ├─ 3. Load issue.json for current objective
    │
    ├─ 4. Estimate raw snapshot token size
    │     if tokens < MIN_SNAPSHOT_TOKENS (400):
    │       → skip reflection, use deterministic
    │
    ├─ 5. Build Haiku reflection prompt
    │     Inputs:
    │       - Current objective (from issue.json)
    │       - Memory entries (scope, key, value, sourceIteration)
    │       - Previous snapshot (for temporal context)
    │       - Task statuses (from tasks.json)
    │     Output schema:
    │       - Categorized items per ActiveContextSnapshot fields
    │
    ├─ 6. Call Haiku via agent SDK query()
    │     - Model: claude-haiku-4-5-20251001
    │     - No tools
    │     - Collect assistant message from event stream
    │
    ├─ 7. Parse Haiku response as JSON
    │     if parse fails:
    │       → fallback to deterministic
    │
    ├─ 8. Acceptance gate
    │     reflected_tokens = estimateTokenSize(haiku_snapshot)
    │     savings = original_tokens - reflected_tokens
    │     if savings < MIN_SAVINGS_TOKENS (100):
    │       → use deterministic (reflection didn't help enough)
    │
    ├─ 9. Validate Haiku output
    │     - Ensure all items trace back to actual memory entries
    │     - Reject any hallucinated items not in source data
    │     - Apply MAX_CATEGORY_ITEMS (25) and MAX_TEXT_LENGTH (260) caps
    │
    └─ 10. Build snapshot, compute retirements, write diagnostics
          (existing logic, unchanged)
```

### Haiku Prompt Design

```
You are a trajectory reduction assistant. Given an agent's current objective
and its memory entries, categorize each entry into the appropriate field
of an active context snapshot.

## Current Objective
{objective}

## Previous Snapshot (iteration {N-1})
{previous_snapshot_summary}

## Memory Entries
{entries as JSON array: [{scope, key, value, sourceIteration}, ...]}

## Task Statuses
{tasks as JSON array: [{id, title, status}, ...]}

## Instructions
1. Categorize each memory entry into exactly one of:
   - open_hypotheses: Active theories being tested
   - blockers: Issues currently preventing progress
   - next_actions: Concrete steps to take next
   - unresolved_questions: Open questions needing answers
   - required_evidence_links: URLs, file paths, or artifact references
   - irrelevant: Safe to exclude from the snapshot

2. Consolidate semantically-similar items into a single entry.
   Example: "CI is red" + "3 tests failing" + "test suite broken" → "CI failing: 3 test failures"

3. For items marked irrelevant, briefly note why (resolved, superseded, stale).

4. Set current_objective to a concise summary of the primary goal.

5. Do NOT invent information not present in the entries.

## Output Format (strict JSON)
{
  "current_objective": "string",
  "open_hypotheses": ["string", ...],
  "blockers": ["string", ...],
  "next_actions": ["string", ...],
  "unresolved_questions": ["string", ...],
  "required_evidence_links": ["string", ...],
  "dropped": [{"value": "string", "reason": "string"}, ...]
}
```

### Deterministic Fallback

The existing keyword-regex path (`collectCategoryFromMemory()`, `isLikelyBlocker()`, etc.) remains as the fallback. It is used when:
- Snapshot is below token threshold
- Haiku API call fails (network, timeout, rate limit)
- Haiku response fails JSON parsing
- Haiku response fails validation (hallucinated entries)
- Token savings below minimum threshold

### Safety Invariants

1. **No hallucination**: Every item in the reflected snapshot must trace to a source memory entry or task. Validation rejects any item whose text doesn't substring-match a source.
2. **Caps preserved**: `MAX_CATEGORY_ITEMS` (25) and `MAX_TEXT_LENGTH` (260) are enforced post-reflection, same as deterministic path.
3. **Audit trail**: The `dropped` array from Haiku's response is logged in diagnostics for post-hoc analysis.
4. **Retired trajectory unchanged**: Retirement logic compares current vs. previous snapshot regardless of which path produced the current snapshot.

---

## 6. Cost Analysis

### Per-Reflection Call

| Component | Tokens | Cost (Haiku) |
|-----------|--------|--------------|
| Prompt template + instructions | ~400 | — |
| Memory entries (typical 20-50) | ~1,000-2,500 | — |
| Previous snapshot | ~400 | — |
| Task statuses | ~200 | — |
| **Total input** | **~2,000-3,500** | **$0.002-0.0035** |
| **Output (categorized JSON)** | **~500-800** | **$0.0025-0.004** |
| **Total per call** | — | **~$0.005-0.008** |

### Compared to Main Model

| Scenario | Main model cost/iter | Reflection overhead | Ratio |
|----------|---------------------|-------------------|-------|
| Opus iteration (50K in, 5K out) | ~$1.13 | ~$0.006 | 0.5% |
| Sonnet iteration (50K in, 5K out) | ~$0.23 | ~$0.006 | 2.6% |
| Haiku iteration (50K in, 5K out) | ~$0.075 | ~$0.006 | 8.0% |

Reflection overhead is negligible for Opus/Sonnet iterations. For Haiku-on-Haiku (unlikely in practice), it's still under 10%.

### AgentDiet Paper Reference

The paper found GPT-4o mini reflection at 5-15% overhead delivered 21-30% net cost savings. Our overhead is lower (~0.5-3%) because we're reflecting on a small structured snapshot, not raw tool outputs.

---

## 7. Evaluation Plan

### Metrics

| Metric | Definition | Target |
|--------|-----------|--------|
| **Categorization accuracy** | Manual audit: % of entries correctly categorized | > 90% (vs ~70% estimated for keyword regex) |
| **False retirement rate** | Items dropped by reflection that deterministic would keep, and that matter | < 5% |
| **Consolidation rate** | Reduction in item count from merging semantically-similar entries | 10-30% |
| **Net snapshot token delta** | `deterministic_tokens - reflected_tokens` (excluding reflection overhead) | > 100 tokens savings |
| **Reflection latency** | Wall-clock time for Haiku call | < 3 seconds p95 |
| **Fallback rate** | % of iterations where reflection is skipped or rejected | < 20% |

### Experiment Design

Run 5-10 real issues through both paths on the same DB state:
1. Compute deterministic snapshot (existing code)
2. Compute reflected snapshot (new code)
3. Diff the two snapshots
4. Manual audit of disagreements
5. Track across full run to completion

Compare: iteration count to terminal phase, total cost (main + reflection), regression incidents (lost context causing repeated work).

### Success Criteria

- Reflection produces measurably better categorization on manual audit
- No increase in iteration count to completion
- Net cost including reflection overhead is equal or lower
- Zero regression incidents from lost critical context

---

## 8. Tasks

### Dependency Graph
```
T1 (no deps)
T2 → depends on T1
T3 → depends on T2
T4 → depends on T2
T5 → depends on T3, T4
```

### Task Breakdown

| ID | Title | Files | Acceptance Criteria |
|----|-------|-------|---------------------|
| T1 | Add `@anthropic-ai/claude-agent-sdk` to viewer-server | `apps/viewer-server/package.json` | Dependency installs, typecheck passes |
| T2 | Implement `reflectTrajectory()` function | `apps/viewer-server/src/trajectoryReflection.ts` | Calls Haiku, parses response, validates output, returns categorized snapshot |
| T3 | Integrate reflection into `computeTrajectoryReduction()` | `apps/viewer-server/src/trajectoryReduction.ts` | Calls reflection with gating, falls back to deterministic on failure |
| T4 | Add reflection diagnostics to trajectory reduction output | `apps/viewer-server/src/trajectoryReduction.ts` | Diagnostics include reflection metrics |
| T5 | Tests for reflection + integration | `apps/viewer-server/src/trajectoryReflection.test.ts`, `apps/viewer-server/src/trajectoryReduction.test.ts` | Unit tests for prompt building, response parsing, validation, gating, fallback |

### Task Details

**T1: Add agent SDK dependency**
- Summary: Add `@anthropic-ai/claude-agent-sdk` to viewer-server's `package.json`
- Acceptance Criteria:
  1. `pnpm install` succeeds
  2. `pnpm typecheck` passes
- Verification: `pnpm install && pnpm typecheck`

**T2: Implement `reflectTrajectory()`**
- Summary: New module that builds the Haiku prompt from memory entries + objective, calls `query()` with Haiku model and no tools, parses the JSON response, validates entries against source data
- Files: `apps/viewer-server/src/trajectoryReflection.ts`
- Acceptance Criteria:
  1. Builds structured prompt from memory entries, objective, previous snapshot, and tasks
  2. Calls agent SDK `query()` with `claude-haiku-4-5-20251001`, no tools
  3. Collects assistant message from event stream
  4. Parses response as JSON matching snapshot schema
  5. Validates every item traces to a source entry (no hallucinations)
  6. Returns categorized snapshot + diagnostics (tokens, latency, dropped items)
  7. Throws/returns error on API failure, parse failure, or validation failure
- Verification: `pnpm test -- trajectoryReflection`

**T3: Integrate into `computeTrajectoryReduction()`**
- Summary: Add reflection call between data collection and snapshot building, with gating and fallback
- Files: `apps/viewer-server/src/trajectoryReduction.ts`
- Acceptance Criteria:
  1. Skips reflection if estimated tokens < 400
  2. Calls `reflectTrajectory()` when above threshold
  3. Applies savings gate (reject if savings < 100 tokens)
  4. Falls back to deterministic on any reflection failure
  5. Existing deterministic tests still pass unchanged
- Verification: `pnpm test -- trajectoryReduction`

**T4: Reflection diagnostics**
- Summary: Extend `TrajectoryReductionDiagnostics` with reflection fields
- Files: `apps/viewer-server/src/trajectoryReduction.ts`
- Acceptance Criteria:
  1. Diagnostics include `reflection_used`, `reflection_input_tokens`, `reflection_output_tokens`, `reflection_latency_ms`, `reflection_skipped_reason`
  2. Viewer log includes `[TRAJECTORY] reflection=used|skipped ...`
- Verification: `pnpm test -- trajectoryReduction`

**T5: Tests**
- Summary: Unit tests for the reflection module and integration tests for the full pipeline
- Files: `apps/viewer-server/src/trajectoryReflection.test.ts`, `apps/viewer-server/src/trajectoryReduction.test.ts`
- Acceptance Criteria:
  1. Tests prompt construction from sample memory entries
  2. Tests JSON response parsing (valid, malformed, empty)
  3. Tests hallucination rejection (item not in source)
  4. Tests gating logic (below threshold, insufficient savings)
  5. Tests fallback on API error
  6. Integration test: reflection produces valid snapshot from realistic fixture data
- Verification: `pnpm test`

---

## 9. Validation

### Pre-Implementation
```bash
pnpm install
pnpm typecheck
pnpm test
```

### Post-Implementation
```bash
pnpm typecheck
pnpm lint
pnpm test
```

### New Tests
- [ ] `apps/viewer-server/src/trajectoryReflection.test.ts` - Prompt building, response parsing, validation, hallucination rejection
- [ ] `apps/viewer-server/src/trajectoryReduction.test.ts` - Gating, fallback, diagnostics (additions to existing test file)

---

## 10. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Haiku over-compresses (AgentDiet found 14.4% Keep%) | Medium | High | Validation against source entries; savings threshold gate; Haiku classifies structured text not raw code |
| Haiku hallucinates entries not in source data | Low | High | Post-reflection validation rejects any item not tracing to source |
| API latency adds >3s per iteration | Low | Medium | Timeout + fallback to deterministic; reflection is non-blocking to run completion |
| Haiku response not valid JSON | Low | Low | JSON parse in try/catch; fallback to deterministic |
| Reflection cost exceeds value on small snapshots | Medium | Low | Token threshold gate (skip if < 400 tokens) |

---

## 11. Future Work (Out of Scope)

- **Retired trajectory re-injection**: Haiku reviews retired items against current objective and resurfaces relevant ones. Deferred until base reflection proves value.
- **Adaptive context controller (#114)**: Reflection could be one of the adaptive knobs. Depends on #114 design.
- **Fine-tuned compression prompt**: Iterate on the Haiku prompt based on evaluation results.
- **Batch reflection**: If multiple issues run concurrently, batch Haiku calls for efficiency.
