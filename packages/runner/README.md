# @jeeves/runner

TypeScript runner package for Jeeves workflows.

## CLI

This package exposes a `jeeves-runner` binary.

### Run the fixture (no credentials)

Runs the `fixture-trivial` workflow using the fake provider and writes artifacts to a local state dir.

```bash
pnpm exec jeeves-runner run-fixture
```

### Run a workflow

```bash
pnpm exec jeeves-runner run-workflow --workflow <name> [--issue <owner/repo#N>]
```

If `--issue` is provided, the runner defaults to XDG state/worktree paths (override with `JEEVES_DATA_DIR`).

## Providers

### Codex (`--provider codex`)

Runs phases via the OpenAI Codex SDK.

Auth:
- Recommended: run `pnpm exec codex` once and choose **Sign in with ChatGPT** (no env var required after sign-in).
- API key: set `OPENAI_API_KEY` (also supports `CODEX_API_KEY`).

Optional configuration:
- `CODEX_MODEL` (or `OPENAI_MODEL`)
- `OPENAI_BASE_URL` (or `CODEX_BASE_URL`)

Default execution policy:
- `sandboxMode: danger-full-access`
- `approvalPolicy: never`

## Artifacts

For each run, the runner writes to the state directory:

- `sdk-output.json` (schema `jeeves.sdk.v1`)
- `last-run.log`
- `progress.txt`

## Optional: tool result pruning

The runner can optionally pass `tool_result` payloads through a pruning hook before writing them to `sdk-output.json`.

For the Claude provider, pruning can also be applied to the model's **live context** by replacing the built-in `Read` tool with a pruned MCP `Read` tool when `JEEVES_PRUNER_ENABLED` is set. This is required for actual token-cost reduction during the run.

Environment variables:
- `JEEVES_PRUNER_ENABLED`: enable the pruner hook (`true`/`1`/`yes`)
- `JEEVES_PRUNER_URL`: pruner service URL (default: `http://localhost:8000/prune`)
- `JEEVES_PRUNER_TARGET_TOOLS`: comma-separated tool names to prune (default: `Read,Bash,Grep,command_execution`)
- `JEEVES_PRUNER_QUERY`: override the pruning query (default: current phase prompt, truncated)
- `JEEVES_PRUNER_TIMEOUT_MS`: request timeout in milliseconds (default: `30000`)
- `JEEVES_PRUNER_THRESHOLD`: optional pruning threshold (passed through if set)

## Provider defaults

The `claude` provider uses the Claude Agent TypeScript SDK with:

- `permissionMode: 'bypassPermissions'`
- `allowDangerouslySkipPermissions: true`

This is an intentional default for now (trusted local automation) and is not configurable yet.
