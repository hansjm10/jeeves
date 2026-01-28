# Jeeves

**Autonomous AI Agent Orchestration for Software Development**

Jeeves is an intelligent automation framework that transforms GitHub issues into production-ready pull requests. It orchestrates AI coding agents through a structured, multi-phase workflow—handling everything from design documentation to code review, test coverage, and CI validation.

## Why Jeeves?

Modern AI coding assistants are powerful but stateless. They lose context between sessions, can't persist learnings, and require constant human oversight. Jeeves solves this by:

- **Maintaining persistent memory** across agent sessions via git history and structured state files
- **Automating the complete development lifecycle** from issue to merged PR
- **Ensuring quality through multiple validation phases** including automated review, coverage analysis, and CI verification
- **Learning from each iteration** and preserving institutional knowledge for future work

## Key Features

| Feature | Description |
|---------|-------------|
| **Multi-Agent Support** | Works with Codex CLI, Claude CLI, and Opencode CLI |
| **Phased Workflow** | Design → Implement → Review → Coverage → CI |
| **Persistent Context** | Learnings persist across sessions via `progress.txt` |
| **Quality Gates** | Automated review loops with configurable pass requirements |
| **Real-time Monitoring** | Web dashboard for tracking progress and logs |
| **SonarCloud Integration** | Optional static analysis phase |

## Quick Start

### Prerequisites

- [Codex CLI](https://github.com/openai/codex), [Claude CLI](https://claude.ai), or [Opencode CLI](https://opencode.ai)
- `jq` for JSON processing
- `gh` CLI (optional, for GitHub integration)
- Python 3.9+ (for viewer and Python CLI)

### Installation

```bash
# Clone the repository
git clone https://github.com/hansjm10/jeeves.git
cd jeeves

# Install Python package (editable mode)
pip install -e .
```

### Basic Usage

```bash
# Initialize from a GitHub issue (using init script)
./scripts/init-issue.sh --issue 42

# Run Jeeves using the legacy bash CLI
./scripts/legacy/jeeves.sh --max-iterations 10

# Or use the Python CLI
jeeves run --max-iterations 10
```

## Workflow Phases

Jeeves advances through these phases automatically based on completion status:

1. **Design** — Generates a design document from your template when one doesn't exist
2. **Implement** — Writes code and opens a pull request with proper description
3. **Review** — Iterates on code quality until passing multiple clean review cycles
4. **Coverage** — Adds tests and improves coverage without modifying production code
5. **Sonar** — Addresses static analysis findings (when configured)
6. **CI** — Verifies all GitHub Actions checks pass

Each phase updates `.jeeves/issue.json` status flags, allowing Jeeves to resume from any point.

## Repository Structure

```
jeeves/
├── README.md                    # This file
├── CLAUDE.md / AGENTS.md        # Agent instructions
├── pyproject.toml               # Python package configuration
├── LICENSE
│
├── src/jeeves/                  # Core Python package
│   ├── __init__.py
│   ├── cli.py                   # Python CLI entry point
│   ├── core/                    # Core logic modules
│   │   ├── issue.py             # Issue management
│   │   ├── repo.py              # Repository operations
│   │   ├── browse.py            # Issue browsing
│   │   ├── config.py            # Configuration handling
│   │   ├── paths.py             # Path utilities
│   │   └── worktree.py          # Git worktree management
│   ├── runner/                  # Agent runners
│   │   ├── config.py
│   │   ├── output.py
│   │   ├── sdk_runner.py
│   │   └── providers/           # Provider implementations
│   └── viewer/                  # Web dashboard
│       ├── server.py            # HTTP server
│       ├── tui.py               # Terminal UI
│       └── static/              # Static files
│           └── index.html
│
├── prompts/                     # Prompt templates
│   ├── issue.design.md
│   ├── issue.implement.md
│   ├── issue.review.md
│   ├── issue.coverage.md
│   ├── issue.ci.md
│   └── ...                      # Other phase prompts
│
├── scripts/                     # Helper scripts
│   ├── init-issue.sh            # Initialize issue from GitHub
│   ├── create-issue-from-design-doc.sh
│   ├── sonarcloud-issues.sh
│   └── legacy/                  # Deprecated scripts
│       ├── jeeves.sh            # Legacy bash CLI
│       └── jeeves.test.sh
│
├── tests/                       # All tests
│   ├── test_*.py
│   └── conftest.py
│
├── docs/                        # Documentation
│
├── examples/                    # Example configurations
│   └── issue.json.example
│
└── skills/                      # Skills directory
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JEEVES_RUNNER` | `auto` | Agent runner: `codex`, `claude`, `opencode`, or `auto` |
| `JEEVES_STATE_DIR` | `~/.local/share/jeeves` | Directory for state files |
| `JEEVES_OUTPUT_MODE` | `compact` | Output mode: `compact` or `stream` |
| `JEEVES_METRICS` | `1` | Enable JSONL metrics logging |
| `JEEVES_DEBUG` | `1` | Enable debug JSONL per phase |

### Issue Configuration

```json
{
  "project": "MyProject",
  "branchName": "issue/42-feature-name",
  "issue": { "number": 42, "repo": "owner/repo" },
  "designDocPath": "docs/feature-design.md",
  "status": {
    "implemented": false,
    "prCreated": false,
    "reviewClean": false,
    "coverageClean": false,
    "ciClean": false
  },
  "config": {
    "reviewCleanPassesRequired": 3
  }
}
```

## Monitoring

### Web Dashboard

```bash
# Start the viewer server
python -m jeeves.viewer.server

# Open http://localhost:8080
```

The dashboard provides:
- Real-time phase and status indicators
- Live log streaming with syntax highlighting
- Progress tracking across iterations
- Prompt template editing

### Metrics & Debugging

Jeeves generates comprehensive logs for analysis:

```bash
# Latest run metrics
cat .jeeves/current-run.json

# Per-phase debug logs
ls .jeeves/.runs/<runId>/debug-*.jsonl

# Aggregate metrics
jq -s 'group_by(.phase) | map({phase:.[0].phase, count:length})' .jeeves/metrics.jsonl
```

## State Files

Jeeves maintains state in the `.jeeves/` directory within your project:

```
.jeeves/
├── issue.json          # Current issue configuration and status
├── progress.txt        # Persistent learnings across iterations
├── last-run.log        # Raw output from last agent session
├── metrics.jsonl       # Aggregated run metrics
└── .runs/              # Per-run artifacts and debug logs
```

Each iteration spawns a fresh agent session with clean context. Memory persists through:
- Git history (commits from previous iterations)
- `progress.txt` (patterns and learnings)
- `issue.json` (workflow state)

## Development

### Running Tests

```bash
# Run all tests
pytest tests/

# Run with coverage
pytest tests/ --cov=src/jeeves
```

### Installing for Development

```bash
pip install -e .
```

## Integration

### GitHub Actions

```yaml
- name: Run Jeeves
  run: |
    ./scripts/legacy/jeeves.sh --max-iterations 5
  env:
    JEEVES_RUNNER: claude
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### SonarCloud

```bash
# Configure in .env.sonarcloud
SONAR_TOKEN=your_token_here
SONAR_ORG=your_org
SONAR_PROJECT=your_project
```

## License

Apache 2.0 with Commons Clause — See [LICENSE](LICENSE) for details.

You are free to use, modify, and distribute Jeeves for your own projects. Commercial resale of Jeeves itself is restricted.

## Support

- [Documentation](docs/)
- [Issue Tracker](https://github.com/hansjm10/jeeves/issues)
