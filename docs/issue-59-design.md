---
title: "Issue #59: Workflow viewer + editor"
status: Draft
last_updated: 2026-02-01
---

# Issue #59: Workflow viewer + editor

## 1. Summary

Add a workflows UI that can (1) list and load workflow YAMLs, (2) visualize phases/transitions as an interactive graph, and (3) edit and save workflows safely via viewer-server APIs.

This document is the canonical spec for:
- Workflow CRUD API contracts (including error formats, status codes, and filesystem safety).
- Provider/model semantics end-to-end (validation, mapping rules, and failure handling).

## 2. Goals / Non-Goals

Goals:
- Edit workflows via a structured model and round-trip to canonical YAML.
- Support per-phase provider overrides for phase execution.
- Provide safe workflow file CRUD with strong guardrails against path traversal and symlink attacks.

Non-goals:
- Arbitrary filesystem access beyond the configured workflows directory.
- Silent “best effort” fallback when a specified provider is invalid or unavailable.

## 3. Workflow model (runtime semantics)

### 3.1 YAML shape (high level)

Workflows are stored as YAML files under `workflows/` and have a stable top-level structure:

```yaml
workflow:
  name: default
  default_provider: codex   # optional
phases:
  design:
    prompt: prompts/issue.design.md
    provider: claude        # optional
    transitions:
      - to: implement
        when: "<promise>DESIGN_APPROVED</promise>"
  implement:
    prompt: prompts/issue.implement.md
```

Notes:
- `workflow.default_provider` maps to the typed `Workflow.defaultProvider` field.
- `phases.<id>.provider` maps to the typed `Phase.provider` field.

### 3.2 Provider selection (mapping rules)

For each phase execution, viewer-server must compute an **effective provider** for that phase:

1. If `phase.provider` is set, it is used.
2. Else if `workflow.default_provider` is set, it is used.
3. Else fall back to the provider chosen when the run was started (the “run-start provider”).

The effective provider is passed to the runner via CLI:
- `jeeves-runner run-phase --workflow <workflowName> --phase <phaseId> --provider <effectiveProvider> ...`

### 3.3 Provider validation (no silent fallback)

Validation happens in viewer-server before spawning the runner:
- Allowed provider names are the set supported by the local runner integration (currently `claude`, `codex`, `fake`).
- If a workflow references an unknown provider name (in either `workflow.default_provider` or any `phases.<id>.provider`), the run must **fail fast**:
  - The phase is not started.
  - An error is recorded/logged.
  - The system does not silently substitute a different provider.

### 3.4 Failure handling

If spawning the runner fails (process spawn error, non-zero exit, or provider initialization error):
- The current iteration/run is marked failed for that phase.
- The failure is surfaced to the UI via existing run status and logs.
- No automatic retry with a different provider is performed.

## 4. Workflow CRUD API (viewer-server)

All endpoints are JSON and respond with `Content-Type: application/json`.

### 4.1 Response envelope

Success:
```jsonc
{ "ok": true, "result": { /* endpoint-specific */ } }
```

Error:
```jsonc
{ "ok": false, "error": { "code": "bad_request", "message": "..." , "details": {} } }
```

### 4.2 Name rules (shared)

Workflow names are **logical names** without extensions. A name maps to a file:
- `<name>` → `workflows/<name>.yaml`

The server must reject names that are not safe:
- Must match: `^[a-z0-9][a-z0-9_-]{0,63}$`
- Must not contain `/`, `\\`, `.` segments, or URL-encoded path separators.

### 4.3 `GET /api/workflows` (list)

Returns all workflow files in `workflowsDir`.

Success `200`:
```jsonc
{
  "ok": true,
  "result": {
    "workflows": [
      { "name": "default", "file": "workflows/default.yaml" }
    ]
  }
}
```

Rules:
- Only include regular files ending in `.yaml` (ignore `.yml` unless explicitly added later).
- Ignore symlinks entirely (do not follow them; do not return them).

### 4.4 `GET /api/workflows/:name` (fetch)

Returns both the raw YAML and a structured workflow payload.

Success `200`:
```jsonc
{
  "ok": true,
  "result": {
    "name": "default",
    "raw_yaml": "workflow:\\n  name: default\\n...",
    "workflow": { /* parsed Workflow model */ }
  }
}
```

Errors:
- `400` for invalid name.
- `404` if the workflow file does not exist.
- `422` if the file exists but cannot be parsed/validated as a workflow (include schema error details).

### 4.5 `PUT /api/workflows/:name` (validate + save)

Validates and atomically writes the workflow YAML, rejecting invalid payloads without writing.

Request body (one of):
```jsonc
{ "raw_yaml": "workflow:\n  name: default\n..." }
```
or
```jsonc
{ "workflow": { /* Workflow model */ } }
```

Behavior:
- If `raw_yaml` is provided:
  - Parse + validate the YAML into the typed model.
- If `workflow` is provided:
  - Validate the object via the core schema.
  - Serialize via canonical YAML output (stable key ordering).
- On success, write the canonical YAML for the workflow.

Success `200`:
```jsonc
{
  "ok": true,
  "result": {
    "name": "default",
    "raw_yaml": "workflow:\\n  name: default\\n...",
    "workflow": { /* parsed Workflow model */ }
  }
}
```

Errors:
- `400` for invalid name or malformed request body.
- `404` if saving requires an existing file and it is missing (optional policy; for “create”, use POST).
- `409` if a safe-write precondition fails (e.g. target is a symlink).
- `422` if validation fails; must not write any file.

### 4.6 `POST /api/workflows` (create)

Creates a new workflow file with a safe name.

Request body:
```jsonc
{ "name": "my-workflow" }
```

Behavior:
- Validate name.
- Fail if the file already exists.
- Create a minimal valid workflow document with:
  - `workflow.name = <name>`
  - `phases` contains at least one valid starting phase (exact defaults are UI-driven; this endpoint only guarantees the created file is schema-valid).

Success `201`:
```jsonc
{
  "ok": true,
  "result": {
    "name": "my-workflow",
    "file": "workflows/my-workflow.yaml"
  }
}
```

Errors:
- `400` invalid name.
- `409` already exists or safe-write precondition fails.
- `500` write errors.

### 4.7 `POST /api/issue/workflow` (select workflow; optionally set phase)

Updates the current issue’s workflow selection.

Request body:
```jsonc
{ "workflow": "default", "phase": "implement" } // phase is optional
```

Behavior:
- Validate workflow name and ensure it exists under `workflowsDir`.
- If `phase` is provided:
  - Load the workflow and ensure the phase exists.
  - Update `issue.json.phase` to the requested phase.
- Always update `issue.json.workflow` to the requested workflow.

Success `200`:
```jsonc
{ "ok": true, "result": { "workflow": "default", "phase": "implement" } }
```

Errors:
- `400` invalid name/body.
- `404` workflow (or phase) not found.

## 5. Filesystem safety constraints (including symlink handling)

All workflow file operations must be constrained to `workflowsDir` and must not follow symlinks.

### 5.1 Directory constraints
- `workflowsDir` must be treated as a **trusted root** only if it is a real directory (not a symlink).
- The server must enumerate workflows via `readdir` of `workflowsDir` and must ignore non-regular files.

### 5.2 Path traversal prevention
- Never accept filesystem paths from the client.
- Convert a validated workflow name to a filename by concatenation (`${name}.yaml`) and joining against `workflowsDir`.
- Reject any name that could escape the directory (`..`, separators, URL-encoded separators).

### 5.3 Symlink handling (read + write)

Read:
- When listing or reading a workflow file, use `lstat` and require:
  - `isFile() === true`
  - `isSymbolicLink() === false`
- If the entry is a symlink (even if it points inside `workflowsDir`), treat it as invalid and ignore/reject it.

Write (atomic):
- Writes must be atomic: write to a temporary file in `workflowsDir`, fsync, then rename into place.
- Before replacing an existing workflow file, verify it is a regular file and not a symlink.
- After the rename, verify the destination is still a regular file (defense-in-depth).
- If any safety check fails, return `409` and do not modify the destination file.

These checks are required to prevent an attacker-controlled symlink from redirecting a write outside `workflowsDir`.

## 6. Validation sources

Workflow validation is performed using the core workflow schema:
- YAML parsing/validation: `parseWorkflowYaml(...)`
- Object validation: `parseWorkflowObject(...)`
- Canonical serialization: `toWorkflowYaml(...)`

The viewer-server API uses these helpers so the UI can round-trip:
- model → canonical YAML → model

