# Jeeves

**SDK-only agent runner with a real-time viewer**

Jeeves is a proof‑of‑concept orchestration layer that runs agent SDK sessions (Claude Agent SDK or OpenAI Codex) and streams structured output to a web dashboard. The viewer is the primary interface: it initializes issues, manages worktrees, launches runs, and shows logs and SDK events in real time.

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 10+
- Git (Git for Windows on native Windows hosts)
- `gh` CLI (optional, for GitHub issue metadata)

### Install

```bash
pnpm install
```

### Start the viewer

```bash
pnpm dev
# UI: http://127.0.0.1:8080
# API: http://127.0.0.1:8081
```

## Viewer Workflow

1. **Init Issue** (Setup tab) – clone repo, create issue state, and create worktree.
2. **Choose Phase** – Design, Implement, Review, or Complete.
3. **Run** – launches the SDK runner and streams logs + SDK events.
4. **Edit Prompts** – edit `prompts/issue.*.md` in the Prompts tab.

## State Directory

Jeeves stores state under a platform-default data directory (override with `JEEVES_DATA_DIR`):

- Linux: `$XDG_DATA_HOME/jeeves` or `~/.local/share/jeeves`
- macOS: `~/Library/Application Support/jeeves`
- Windows: `%LOCALAPPDATA%\\jeeves`

Typical layout:

```
~/.local/share/jeeves/
├── repos/
├── worktrees/
├── issues/
│   └── owner/repo/123/
│       ├── issue.json
│       ├── progress.txt
│       ├── last-run.log
│       ├── viewer-run.log
│       └── sdk-output.json
```

## Minimal issue.json schema

```json
{
  "schemaVersion": 1,
  "repo": "owner/repo",
  "issue": { "number": 42, "title": "Example issue", "url": "..." },
  "branch": "issue/42-example",
  "phase": "design",
  "designDocPath": "docs/issue-42-design.md",
  "notes": ""
}
```

## Skills

Jeeves uses a phase-based skill provisioning system that provides contextual guidance during different workflow phases. Skills are markdown files with YAML frontmatter that get copied to `.claude/skills/` before each phase.

### Integrated External Skills

Jeeves includes high-quality skills adapted from external sources:

| Skill | Purpose | Source |
|-------|---------|--------|
| **pr-review** | Evidence-based PR review orchestration with self-audit | codex-skills |
| **pr-evidence** | Extract factual evidence from diffs | codex-skills |
| **pr-requirements** | Extract acceptance criteria from issues | codex-skills |
| **pr-audit** | Audit reviews for false positives | codex-skills |
| **sonarqube** | SonarQube/SonarCloud API integration | codex-skills |
| **differential-review** | Security-focused code review | [Trail of Bits](https://github.com/trailofbits/skills) |
| **frontend-design** | Production-grade UI design guidance | [Anthropic](https://github.com/anthropics/skills) |

### Phase Mappings

| Phase | Skills Provisioned |
|-------|-------------------|
| All phases | jeeves, progress-tracker, sonarqube |
| design_* | architecture-patterns |
| implement_task | test-driven-dev, frontend-design |
| code_review | code-quality, pr-review, pr-evidence, pr-requirements, pr-audit, differential-review |

See [docs/integrated-skills.md](docs/integrated-skills.md) for detailed skill documentation.

## Repository Structure

```
jeeves/
├── apps/
│   ├── viewer/                  # React UI (Vite)
│   └── viewer-server/           # Fastify API server + run control (Node)
├── packages/
│   ├── core/                    # State model, workflows, prompt resolution
│   ├── runner/                  # CLI + SDK runner integration
│   └── shared/                  # Shared utilities
├── skills/                      # Skill definitions (SKILL.md files)
│   ├── common/                  # Skills for all phases
│   ├── design/                  # Design phase skills
│   ├── implement/               # Implementation phase skills
│   ├── review/                  # Code review skills
│   └── registry.yaml            # Phase-to-skill mappings
├── prompts/                     # Prompt templates
├── scripts/                     # Helper scripts
└── examples/                    # Example configurations
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JEEVES_DATA_DIR` | OS-dependent data-dir | Base directory for repos/worktrees/issues |
| `VITE_VIEWER_SERVER_URL` | `window.location.origin` | Viewer UI base URL for viewer-server REST/WS calls (set to bypass the Vite proxy) |
| `OPENAI_API_KEY` | (none) | OpenAI API key for the `codex` provider (also supports `CODEX_API_KEY`) |
| `CODEX_MODEL` | (none) | Model override for the `codex` provider (falls back to `OPENAI_MODEL`) |
| `OPENAI_BASE_URL` | (none) | Base URL override for the `codex` provider (also supports `CODEX_BASE_URL`) |

For MCP pruner on Windows, optional overrides are available:

- `MCP_PRUNER_BASH_PATH`: absolute path to `bash.exe`
- `MCP_PRUNER_GREP_PATH`: absolute path to `grep.exe`

## Development

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

TypeScript viewer-server API docs: `docs/viewer-server-api.md`

Open the UI at `http://127.0.0.1:8080`.

#### Docker note (port mapping)

If you run the UI in a container and publish `8060:8080`, open `http://<docker-host-ip>:8060/`.

If the viewer-server is running somewhere other than `127.0.0.1:8081` *from inside the UI container*, set:

```bash
VITE_VIEWER_SERVER_PROXY_TARGET=http://<host-or-service>:8081 pnpm dev:viewer
```
