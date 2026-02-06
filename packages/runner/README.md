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

## Provider defaults

The `claude` provider uses the Claude Agent TypeScript SDK with:

- `permissionMode: 'bypassPermissions'`
- `allowDangerouslySkipPermissions: true`
- A process-safety guard that blocks broad Bash kill commands by default (`pkill`, `killall`, `fuser -k`, and related patterns) to avoid terminating Jeeves itself

This is an intentional default for now (trusted local automation). To intentionally bypass the Bash kill-command guard for a run, set `JEEVES_ALLOW_DANGEROUS_PROCESS_KILL=true`.
