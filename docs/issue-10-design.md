---
title: Replace Main Log View with Real-time SDK Viewer as Default
sidebar_position: 6
---

# Replace Main Log View with Real-time SDK Viewer as Default

Use this document as the canonical design for implementing real-time SDK streaming and making the SDK Viewer the default view in the Jeeves Viewer dashboard.

## Document Control
- **Title**: Replace Main Log View with Real-time SDK Viewer as Default
- **Authors**: Jeeves Agent
- **Reviewers**: TBD
- **Status**: Draft
- **Last Updated**: 2026-01-28
- **Related Issues**: [#10](https://github.com/hansjm10/jeeves/issues/10)
- **Execution Mode**: AI-led

## 1. Summary

The Jeeves Viewer currently defaults to showing raw logs, requiring users to manually switch to the "SDK" tab for structured conversation output. The SDK Viewer also requires manual refresh clicks while the Logs tab has real-time SSE streaming. This design addresses these UX gaps by: (1) making SDK Viewer the default tab, (2) adding real-time SSE streaming for SDK output, and (3) introducing an abstract provider model to support future multi-SDK backends (Claude SDK, Codex, OpenCode).

## 2. Context & Problem Statement

- **Background**: The Jeeves Viewer (`viewer/server.py`, `viewer/index.html`) provides a web dashboard with two main content views: "Logs" (raw text output) and "SDK" (structured conversation view). The Logs tab uses SSE streaming with 100ms polling via `LogWatcher` class, while the SDK tab requires manual refresh button clicks.
- **Problem**:
  1. SDK Viewer is not the default despite providing more valuable structured output
  2. SDK Viewer lacks real-time updates - users must click "Refresh" manually
  3. Current `jeeves.sdk.v1` schema is tightly coupled to Claude Code SDK with no abstraction for other providers
  4. No streaming mechanism exists for SDK output changes
- **Forces**:
  - Must maintain backward compatibility with existing `sdk-output.json` v1 format
  - Should not break existing Logs tab functionality
  - Real-time updates must handle large message counts (1000+) without performance degradation
  - Solution must work with existing SSE infrastructure

## 3. Goals & Non-Goals

### Goals
1. Make SDK Viewer the default tab when opening the dashboard
2. Implement real-time SSE streaming for SDK output updates (like Logs tab)
3. Design abstract `jeeves.output.v2` schema for multi-SDK support
4. Create `OutputProvider` abstraction for provider-specific adapters
5. Maintain backward compatibility with v1 schema
6. Track token usage when providers support it

### Non-Goals
- Full UI redesign (enhanced conversation view, flame graphs) - deferred to Phase 3
- Historical session browsing (current session only)
- Real-time collaboration features
- Implementing Codex/OpenCode providers (prepare extension points only)

## 4. Stakeholders, Agents & Impacted Surfaces

- **Primary Stakeholders**: Jeeves users, Jeeves maintainers
- **Agent Roles**:
  - **Implementation Agent**: Builds SDKOutputWatcher, SSE events, provider abstraction
  - **Test Agent**: Writes unit/integration tests for new functionality
- **Affected Packages/Services**:
  - `viewer/server.py` - Add SDKOutputWatcher, SDK SSE events, default tab state
  - `viewer/index.html` - Tab default, SSE subscription for SDK events
  - `jeeves/runner/output.py` - Extend SDKOutput model for v2
  - `jeeves/runner/sdk_runner.py` - Emit v2 schema, incremental saves
  - `jeeves/runner/providers/__init__.py` (new) - Provider package
  - `jeeves/runner/providers/base.py` (new) - OutputProvider base class
  - `jeeves/runner/providers/claude_sdk.py` (new) - Claude SDK adapter
  - `docs/output-schema-v2.json` (new) - v2 JSON Schema
- **Compatibility Considerations**:
  - v1 `sdk-output.json` files must continue to work
  - Viewer must detect schema version and handle appropriately
  - Existing Log SSE stream remains unchanged

## 5. Current State

### Current Architecture

The viewer implements:
- **LogWatcher class** (`viewer/server.py:149-223`): File watcher with position tracking, gets new lines via `get_new_lines()`, returns incremental updates
- **SSE streaming** (`viewer/server.py:1620-1702`): `_handle_sse()` sends `state`, `logs`, and `heartbeat` events at 100ms intervals
- **SDK endpoints** (`viewer/server.py:1495-1542`): Static `GET /api/sdk-output` returns full JSON, no streaming

### Current SDK Output Schema (v1)

```json
{
  "schema": "jeeves.sdk.v1",
  "session_id": "string",
  "started_at": "ISO8601",
  "ended_at": "ISO8601",
  "success": true,
  "messages": [...],
  "tool_calls": [...],
  "stats": { "message_count": 0, "tool_call_count": 0, "duration_seconds": 0 }
}
```

### Current Frontend SDK Tab

- Located at `viewer/index.html:1240-1264`
- Requires manual "Refresh" button click (`btnSdkRefresh`)
- Fetches `/api/sdk-output` synchronously
- No SSE subscription for SDK updates

### Relevant Source Files
| File | Purpose | Key Lines |
|------|---------|-----------|
| `viewer/server.py` | Web server, SSE, file watching | 149-223 (LogWatcher), 1620-1702 (SSE) |
| `viewer/index.html` | Frontend dashboard | 1240-1264 (SDK panel), 1294-1450 (SDK JS) |
| `jeeves/runner/output.py` | SDKOutput model | Full file |
| `jeeves/runner/sdk_runner.py` | SDK runner implementation | 53-63 (incremental save) |
| `docs/sdk-output-schema.json` | v1 schema definition | Full file |

## 6. Proposed Solution

### 6.1 Architecture Overview

The solution adds:
1. **SDKOutputWatcher** - Similar to LogWatcher but for `sdk-output.json`, tracks file changes and extracts new messages/tool calls
2. **SDK SSE Events** - New events (`sdk-init`, `sdk-message`, `sdk-tool-start`, `sdk-tool-complete`, `sdk-complete`) in the existing SSE stream
3. **Provider Abstraction** - Base class for SDK output adapters
4. **v2 Schema** - Extended schema with provider info, token tracking, and raw provider data

```
SSE Stream
├── state         (existing - phase, config, run status)
├── logs          (existing - incremental log lines)
├── heartbeat     (existing - keep-alive)
├── sdk-init      (new - session start with provider info)
├── sdk-message   (new - incremental messages)
├── sdk-tool-start (new - tool invocation)
├── sdk-tool-complete (new - tool completion with timing)
└── sdk-complete  (new - session end with summary)
```

### 6.2 Detailed Design

#### 6.2.1 SDKOutputWatcher Class

```python
class SDKOutputWatcher:
    """Watch SDK output file for changes and track position."""

    def __init__(self, path: Path):
        self.path = path
        self.last_mtime = 0
        self.last_message_count = 0
        self.last_tool_count = 0
        self._lock = Lock()

    def get_updates(self) -> Tuple[List[Message], List[ToolCall], bool]:
        """Get new messages and tool calls since last check.

        Returns:
            (new_messages, new_tool_calls, has_changes)
        """
```

#### 6.2.2 SSE Event Types

```python
# In _handle_sse():
# sdk-init: Sent when session starts
self._sse_send("sdk-init", {
    "session_id": output.session_id,
    "provider": output.provider,  # v2 only
    "status": "running"
})

# sdk-message: Sent for each new message
self._sse_send("sdk-message", {
    "message": message_dict,
    "index": msg_index,
    "total": total_messages
})

# sdk-tool-start: Sent when tool invocation begins
self._sse_send("sdk-tool-start", {
    "tool_use_id": tool_id,
    "name": tool_name,
    "input": tool_input
})

# sdk-tool-complete: Sent when tool returns
self._sse_send("sdk-tool-complete", {
    "tool_use_id": tool_id,
    "duration_ms": duration,
    "is_error": is_error
})

# sdk-complete: Sent when session ends
self._sse_send("sdk-complete", {
    "summary": stats_dict,
    "status": "success" | "error"
})
```

#### 6.2.3 v2 Schema Extension

```json
{
  "schema": "jeeves.output.v2",
  "provider": {
    "name": "claude-sdk",
    "version": "1.0.0",
    "metadata": {}
  },
  "session": {
    "id": "string",
    "started_at": "ISO8601",
    "ended_at": "ISO8601",
    "status": "running" | "success" | "error" | "cancelled"
  },
  "conversation": [...],
  "summary": {
    "message_count": 0,
    "tool_call_count": 0,
    "duration_seconds": 0,
    "tokens": {
      "input": 0,
      "output": 0
    },
    "errors": []
  },
  "raw": {}
}
```

#### 6.2.4 Provider Abstraction

```python
# jeeves/runner/providers/base.py
from abc import ABC, abstractmethod
from typing import Any, Dict
from ..output import Message, ProviderInfo

class OutputProvider(ABC):
    """Base class for SDK output providers."""

    @abstractmethod
    def parse_event(self, event: Any) -> Message:
        """Parse a provider-specific event into a Message."""
        pass

    @abstractmethod
    def get_provider_info(self) -> ProviderInfo:
        """Return provider metadata."""
        pass

    @property
    @abstractmethod
    def supports_tokens(self) -> bool:
        """Whether this provider reports token usage."""
        pass

# jeeves/runner/providers/claude_sdk.py
class ClaudeSDKProvider(OutputProvider):
    """Provider adapter for Claude Agent SDK."""

    def get_provider_info(self) -> ProviderInfo:
        return ProviderInfo(
            name="claude-sdk",
            version=claude_agent_sdk.__version__,
            metadata={}
        )
```

#### 6.2.5 Frontend Changes

```javascript
// In connectSSE():
source.addEventListener('sdk-init', (e) => {
    const data = JSON.parse(e.data);
    sdkOutput = { ...sdkOutput, session_id: data.session_id, status: 'running' };
    renderSdkOutput();
});

source.addEventListener('sdk-message', (e) => {
    const data = JSON.parse(e.data);
    sdkOutput.messages.push(data.message);
    renderSdkOutput();
});

// Default tab on load:
const savedTab = localStorage.getItem('jeeves_viewer_main_tab');
setMainTab(savedTab || 'sdk');  // Changed from 'logs' to 'sdk'
```

### 6.3 Operational Considerations

- **Deployment**: No infrastructure changes; viewer remains stdlib-only Python
- **Telemetry & Observability**: SDK stats already tracked in `sdk-output.json`
- **Security & Compliance**: No additional permissions required; uses existing file access

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| ID | Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|----|-------------|---------------|-------------------------|--------------|---------------------|
| T1 | Add SDKOutputWatcher class | Create file watcher for sdk-output.json with incremental tracking | Implementation Agent | None | Watcher tracks message/tool count; returns only new items |
| T2 | Add SDK SSE events to stream | Extend _handle_sse() with sdk-* events | Implementation Agent | T1 | New events sent during agent run; verified in browser devtools |
| T3 | Update frontend for SDK SSE | Subscribe to sdk-* events; remove manual refresh requirement | Implementation Agent | T2 | SDK view updates automatically; Refresh button removed or optional |
| T4 | Make SDK tab the default | Change default tab from 'logs' to 'sdk' | Implementation Agent | T3 | New sessions open to SDK tab; localStorage override preserved |
| T5 | Design jeeves.output.v2 schema | Create JSON Schema document with provider abstraction | Implementation Agent | None | Schema documented in docs/output-schema-v2.json |
| T6 | Create OutputProvider base class | Abstract base class for provider adapters | Implementation Agent | T5 | Base class with parse_event, get_provider_info methods |
| T7 | Implement ClaudeSDKProvider | Adapter for current claude-agent-sdk output | Implementation Agent | T6 | Provider produces identical output to v1 |
| T8 | Add schema version detection | Viewer handles both v1 and v2 output files | Implementation Agent | T7 | Viewer displays v1 and v2 outputs correctly |
| T9 | Add token tracking to v2 | Track input/output tokens when provider supports it | Implementation Agent | T7 | Token counts displayed in SDK stats bar |
| T10 | Integration tests for SDK streaming | End-to-end tests for SSE SDK events | Test Agent | T3 | Tests pass; coverage meets threshold |

### 7.2 Milestones

- **Phase 1 (High Priority)**: T1, T2, T3, T4 - Real-time SDK streaming and default tab
  - Deliverables: SDKOutputWatcher, SDK SSE events, frontend subscription, default tab change
  - Timeline: 1-2 iterations
  - Gating: SDK view updates automatically during agent run

- **Phase 2**: T5, T6, T7, T8, T9 - Provider abstraction and v2 schema
  - Deliverables: v2 schema, OutputProvider base, ClaudeSDKProvider, version detection
  - Timeline: 2-3 iterations
  - Gating: v1/v2 compatibility verified; token tracking works

- **Phase 3 (Deferred)**: Enhanced UI/UX
  - Deliverables: Collapsible message groups, syntax highlighting, flame graph timeline
  - Timeline: Future issue
  - Gating: Phase 1-2 stable

### 7.3 Coordination Notes

- **Hand-off Package**: This design doc, `viewer/server.py`, `viewer/index.html`, `jeeves/runner/output.py`
- **Communication Cadence**: Update `.jeeves/progress.txt` after each task completion
- **Escalation Path**: Open questions in this doc; user feedback via GitHub issues

## 8. Agent Guidance & Guardrails

### 8.1 Context Packets
- Load `viewer/server.py`, `viewer/index.html` before implementation
- Review `LogWatcher` class as reference for `SDKOutputWatcher`
- Check existing SSE event format in `_sse_send()` method

### 8.2 Prompting & Constraints
- Follow existing code style (type hints, docstrings)
- Use existing SSE infrastructure - do not create separate WebSocket
- Maintain stdlib-only requirement for viewer
- Commit messages: `feat(viewer): add SDK SSE streaming`

### 8.3 Safety Rails
- Do not remove or break existing Logs tab functionality
- Do not break existing `/api/sdk-output` endpoint
- Do not require additional Python dependencies
- Preserve backward compatibility with v1 schema files

### 8.4 Validation Hooks
- Run `python -m pytest viewer/` before marking task complete
- Verify SSE events in browser DevTools Network tab
- Test with large sdk-output.json (1000+ messages) for performance

## 9. Alternatives Considered

| Alternative | Pros | Cons | Decision |
|-------------|------|------|----------|
| WebSocket instead of SSE | Bidirectional, lower overhead | Extra complexity, new protocol | Rejected - SSE works well for unidirectional updates |
| Polling endpoint | Simpler implementation | Higher latency, more requests | Rejected - SSE provides real-time experience |
| Full rewrite of viewer | Clean slate | High effort, risk | Rejected - incremental improvement preferred |
| GraphQL subscriptions | Modern API pattern | Dependency, complexity | Rejected - overkill for single-client dashboard |

## 10. Testing & Validation Plan

- **Unit Tests**:
  - `SDKOutputWatcher.get_updates()` returns correct incremental data
  - Schema version detection works for v1 and v2
  - Provider adapters produce expected output format

- **Integration Tests**:
  - SSE stream sends sdk-* events during mock agent run
  - Frontend receives and renders incremental updates
  - Tab default and localStorage persistence work correctly

- **Performance Tests**:
  - SDKOutputWatcher handles 1000+ messages without degradation
  - SSE events don't block log streaming
  - Memory usage stable during long runs

- **Manual QA**:
  - Open dashboard, verify SDK is default tab
  - Start agent run, verify real-time updates
  - Switch between Logs and SDK tabs, verify both work
  - Test with v1 sdk-output.json file (backward compat)

## 11. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SSE event flood with rapid tool calls | Medium | Medium | Rate limit SSE events; batch messages if needed |
| Large JSON files slow to parse | Low | Medium | Incremental parsing; only read changed portions |
| Frontend memory issues with 1000+ messages | Low | Medium | Virtual scrolling for conversation view (Phase 3) |
| Breaking v1 compatibility | Low | High | Version detection; comprehensive tests |

## 12. Rollout Plan

- **Milestones**:
  - v0.4.0: Phase 1 - Real-time SDK streaming (T1-T4)
  - v0.5.0: Phase 2 - Provider abstraction (T5-T9)
  - v0.6.0: Phase 3 - Enhanced UI (deferred)

- **Migration Strategy**:
  - v2 schema is additive; existing v1 files continue to work
  - No user action required for upgrade

- **Communication**:
  - Update `viewer/README.md` with new features
  - Add screenshot showing real-time SDK updates

## 13. Open Questions

1. Should SSE events include full message content or just delta updates for large tool results?
2. What's the optimal polling interval for SDKOutputWatcher - 100ms like logs or configurable?
3. Should we add a "compact mode" for SDK view to handle large conversations?
4. Consider adding session persistence/history in future?

## 14. Follow-Up Work

- Add virtual scrolling for large conversations (separate issue)
- Implement Codex provider adapter (when Codex SDK available)
- Add flame graph timeline visualization (Phase 3)
- Search/filter within SDK conversation view
- Export SDK output as Markdown/HTML report

## 15. References

- [Claude Agent SDK Documentation](https://docs.anthropic.com/claude-code/sdk)
- [SSE Specification](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [Issue #10 - Original Feature Request](https://github.com/hansjm10/jeeves/issues/10)
- `viewer/server.py` - Viewer server implementation
- `viewer/index.html` - Frontend dashboard
- `docs/sdk-output-schema.json` - Current v1 schema
- `jeeves/runner/sdk_runner.py` - SDK runner implementation

## Appendix A - Glossary

| Term | Definition |
|------|------------|
| SSE | Server-Sent Events - HTTP-based protocol for server-to-client streaming |
| SDK | Software Development Kit - here refers to claude-agent-sdk |
| Provider | Abstraction layer for different AI agent SDKs (Claude, Codex, etc.) |
| v1/v2 | Schema version identifiers for SDK output format |

## Appendix B - Change Log

| Date       | Author       | Change Summary |
|------------|--------------|----------------|
| 2026-01-28 | Jeeves Agent | Initial draft |
