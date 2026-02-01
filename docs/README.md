# Jeeves Documentation

This directory contains supplementary documentation for the Jeeves SDK-only agent runner.

## Overriding Max Iterations

By default, Jeeves runs execute up to **10 iterations** before stopping. Each iteration spawns a fresh-context SDK subprocess. You can override this limit using the viewer UI, CLI, or API.

### Viewer UI

In the viewer sidebar under **Controls**:

1. Locate the **Iterations (optional)** field below the provider selector
2. Enter a positive integer (e.g., `5` for 5 iterations, `1` for a quick smoke test)
3. Leave blank to use the default (10 iterations)
4. Click **Start** to begin the run

The UI validates your input:
- Valid positive integers are accepted and stored for future sessions
- Invalid values (0, negative, decimals, non-numeric) show an error and disable the Start button
- The current iteration progress displays as `iterations: X/Y` during a run

### CLI

The `jeeves` CLI provides a `run` command to start runs from the terminal:

```bash
# Start a run with default iterations (10)
jeeves run

# Start a run with 5 iterations
jeeves run --iterations 5

# Start a run with 1 iteration (quick test)
jeeves run --iterations 1

# Start a run with 20 iterations (long-running task)
jeeves run --iterations 20
```

#### Server Override

By default, the CLI connects to the viewer-server at `http://127.0.0.1:8081`. Use `--server` to override:

```bash
# Connect to a custom viewer-server
jeeves run --server http://192.168.1.100:8081

# Combine with iterations
jeeves run --iterations 5 --server http://192.168.1.100:8081
```

#### CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `--iterations <n>` | Maximum iterations for the run (positive integer) | Server default (10) |
| `--server <url>` | Viewer-server URL | `http://127.0.0.1:8081` |
| `--help` | Show help message | — |
| `--version, -v` | Show version number | — |

#### Exit Codes

The CLI exits with code 0 on success. Non-zero exit codes indicate:
- Invalid `--iterations` value (0, negative, non-integer, non-numeric)
- Network/connection errors (server unreachable)
- Server error response (`ok: false`)

### API

The `POST /api/run` endpoint accepts `max_iterations` in the request body:

```bash
# Start run with 5 iterations
curl -X POST http://127.0.0.1:8081/api/run \
  -H "Content-Type: application/json" \
  -d '{"max_iterations": 5}'

# Start run with default iterations (omit the field)
curl -X POST http://127.0.0.1:8081/api/run \
  -H "Content-Type: application/json" \
  -d '{}'
```

See [viewer-server-api.md](viewer-server-api.md) for the full API reference.

### Default Behavior

When `max_iterations` is not specified (blank UI field, omitted CLI flag, or absent from API request body), the server uses the default of **10 iterations**.

The server also applies these rules:
- Values ≤ 0 are clamped to 1 (minimum 1 iteration)
- Float values are truncated to integers (e.g., `2.5` → 2 iterations)
