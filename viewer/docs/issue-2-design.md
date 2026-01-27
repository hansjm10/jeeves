# Design Doc: Rewrite Jeeves in Rust

## Summary
Rewrite the Jeeves agent orchestration system from Bash to Rust for improved performance, type safety, and maintainability. The goal is to replace the current Bash implementation with a robust Rust binary that handles agent orchestration, state management, and tool execution.

## Motivation
The current Bash implementation has grown significantly (~75K lines) and presents several challenges:
- Limited type safety and error handling
- Difficult to test comprehensively
- Complex string manipulation and JSON parsing via `jq`
- Platform-specific shell behavior differences

Rust will provide:
- Strong type system catching errors at compile time
- Excellent error handling with `Result` types
- Native JSON parsing with `serde`
- Cross-platform binary distribution
- Better performance for file I/O and process management
- Easier unit and integration testing

## Goals
- Rewrite the main orchestration loop (`jeeves.sh`) in Rust.
- Implement strictly typed issue and state management.
- Create modular runner abstractions for Codex, Claude, and Opencode.
- Implement structured metrics and debug logging (JSONL).
- Port supporting tools (`init-issue`, `sonarcloud-issues`) to CLI subcommands.

## Non-Goals
- Rewriting the Python-based Viewer (this is a separate decision/project).
- Changing the core agent protocol/interaction model (unless required by the language shift).

## Design

### Architecture
The application will be a single binary `jeeves` constructed with a modular architecture:

- **CLI Layer (`src/main.rs`, `src/cli.rs`)**: Uses `clap` to parse arguments and subcommands (`init`, `run`, `sonar`, `design-doc`).
- **Core Orchestrator (`src/orchestrator.rs`)**: Manages the main loop, iteration limits, and phase transitions.
- **State Management (`src/state.rs`)**: Handles reading/writing `jeeves/issue.json` and `jeeves/progress.txt`. Uses `serde` for type-safe JSON handling.
- **Runner System (`src/runner/`)**: A trait-based system to support multiple agents.
    - `trait Runner { fn run(...) -> Result<...>; }`
    - Implementations for `CodexRunner`, `ClaudeRunner`, `OpencodeRunner`.
- **Utils**: Helpers for Git operations, file I/O, and external process execution (`tokio::process`).

### Data Structures
`IssueConfig` (mapping to `jeeves/issue.json`):
```rust
struct IssueConfig {
    project: String,
    branch_name: String,
    issue: IssueDetails,
    design_doc_path: String,
    status: IssueStatus,
    // ...
}
```

### CLI Interface
```bash
jeeves init --issue 42 --repo owner/repo
jeeves run --max-iterations 10 --runner claude
jeeves sonar
jeeves design-doc
```

### Dependencies
- `clap`: CLI argument parsing
- `serde`, `serde_json`: JSON serialization/deserialization
- `tokio`: Async runtime (required for concurrent operations and process management)
- `reqwest`: HTTP client (GitHub/SonarCloud APIs)
- `tracing`, `tracing-subscriber`: Logging and diagnostics
- `anyhow`: Error handling

## Work Breakdown & Delivery Plan

1.  **Project Initialization**: Create new Rust project, set up directory structure, and add core dependencies (`clap`, `serde`, `tokio`).
2.  **CLI Skeleton**: Implement the `jeeves` binary with subcommands (`init`, `run`) and argument parsing.
3.  **State Management**: Implement `IssueConfig` struct and logic to read/write `jeeves/issue.json`.
4.  **Orchestrator Loop**: Implement the main execution loop, including iteration tracking and phase selection logic.
5.  **Runner Trait & Basic Implementation**: Define the `Runner` trait and implement a basic `OpencodeRunner` (or generic runner) that can execute commands.
6.  **Git & GitHub Integration**: Implement helpers for checking out branches and fetching issue details (replacing `gh` CLI calls where appropriate or wrapping them).
7.  **Port init-issue**: Implement the `init` subcommand logic to set up a new issue workspace.
8.  **Metrics & Logging**: Implement JSONL logging for metrics and debug events.

## Open Questions
- Should we completely replace `gh` CLI dependency with `reqwest` calls to GitHub API, or keep using `gh` for auth convenience? (Assumption: Keep `gh` for now for auth simplicity if possible, or support PATs).
- How to handle legacy Bash scripts during the transition?
