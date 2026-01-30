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

## Artifacts

For each run, the runner writes to the state directory:

- `sdk-output.json` (schema `jeeves.sdk.v1`)
- `last-run.log`
- `progress.txt`

## Provider defaults

The `claude` provider uses the Claude Agent TypeScript SDK with:

- `permissionMode: 'bypassPermissions'`
- `allowDangerouslySkipPermissions: true`

This is an intentional default for now (trusted local automation) and is not configurable yet.

