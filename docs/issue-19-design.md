---
title: Improve Context Tracking - Extract to Service and Fix Reliability Issues
sidebar_position: 19
---

# Improve Context Tracking: Extract to Service and Fix Reliability Issues

## Document Control
- **Title**: Extract context tracking to dedicated service with reliability fixes
- **Authors**: Jeeves AI Agent
- **Status**: Draft
- **Last Updated**: 2025-01-29
- **Related Issues**: [#19](https://github.com/hansjm10/jeeves/issues/19)
- **Execution Mode**: AI-led

## 1. Summary

The current context tracking implementation in Jeeves has several reliability issues: context percentage is only displayed at the end of SDK runs, can display incorrect values (e.g., 700%), and the code is scattered across multiple files. This design proposes extracting context tracking into a dedicated `ContextService` that centralizes calculations, provides model-aware context windows, ensures bounded percentages (0-100%), and prepares for future real-time updates.

## 2. Context & Problem Statement

### Background
Context tracking shows users how much of the AI model's context window is being consumed during an SDK run. This helps users understand when they're approaching limits and need to start a new session.

### Problem
1. **Context only updates at end of turn**: Token usage comes from `message.usage` in SDK `ResultMessage`, which is only available after each SDK response completes
2. **Percentage can exceed 100%**: The calculation doesn't bound the result, leading to confusing displays like "700%"
3. **Hardcoded context window size**: Uses `200,000` (Claude Sonnet default) regardless of actual model
4. **Logic duplicated across files**:
   - `output.py:141-147` - calculation in `to_dict()`
   - `output.py:225-231` - calculation in `to_text()`
   - `sdk_runner.py:96-104` - calculation in `_log_usage_summary()`
   - `index.html:1412-1487` - display logic (already bounds bar width but not text)

### Forces
- Must maintain backward compatibility with existing JSON output schema
- Should not break the real-time viewer updates
- Need to prepare for future SDK improvements (streaming token counts)

## 3. Goals & Non-Goals

### Goals
1. **G1**: Context percentage is always bounded to 0-100% range in calculations
2. **G2**: Context window size is determined by the model being used
3. **G3**: Context logic is centralized in a dedicated service module
4. **G4**: Unit tests achieve >90% coverage for context calculations
5. **G5**: Existing JSON output format remains compatible

### Non-Goals
- **NG1**: Real-time streaming of context during a turn (SDK limitation)
- **NG2**: Client-side token estimation (complexity vs. value)
- **NG3**: Changes to the Claude Agent SDK itself

## 4. Stakeholders, Agents & Impacted Surfaces

### Primary Stakeholders
- Jeeves maintainers
- Users monitoring context usage during runs

### Agent Roles
- **Implementation Agent**: Creates the `ContextService` module and integrates it
- **Test Agent**: Writes comprehensive unit tests

### Affected Packages/Services
- `src/jeeves/context/` - New module (to be created)
- `src/jeeves/runner/output.py` - Remove duplicated logic, use service
- `src/jeeves/runner/sdk_runner.py` - Integrate with ContextService
- `src/jeeves/viewer/static/index.html` - Update display to handle bounded percentages

### Compatibility Considerations
- JSON output schema remains unchanged
- `stats.context_percentage` field continues to be provided
- Values will now be bounded (0-100) which is a bug fix, not breaking change

## 5. Current State

### Context Calculation Flow
```
SDK Run → ResultMessage.usage → SDKOutput token fields → to_dict()/to_text() → JSON output
                                                            ↓
                                                     index.html display
```

### Current Code Locations

**`output.py` (SDKOutput.to_dict, lines 141-147)**:
```python
total_input = self.input_tokens + self.cache_creation_tokens + self.cache_read_tokens
if self.context_window_size > 0:
    stats["context_percentage"] = round(
        (total_input / self.context_window_size) * 100, 1
    )
```

**`output.py` (SDKOutput.to_text, lines 225-231)**:
```python
total_input = self.input_tokens + self.cache_creation_tokens + self.cache_read_tokens
if self.context_window_size > 0:
    context_pct = (total_input / self.context_window_size) * 100
    lines.append(
        f"Context: {context_pct:.1f}% of {self.context_window_size:,}"
    )
```

**`sdk_runner.py` (_log_usage_summary, lines 96-104)**:
```python
total_input = (
    self.output.input_tokens
    + self.output.cache_creation_tokens
    + self.output.cache_read_tokens
)
if self.output.context_window_size > 0:
    context_pct = (total_input / self.output.context_window_size) * 100
    window_k = self.output.context_window_size // 1000
    self._log(f"[USAGE] Context: {context_pct:.1f}% of {window_k}K")
```

**`index.html` (lines 1468-1479)**:
```javascript
const contextPct = sdkOutput.stats?.context_percentage || 0;
if (contextBarEl) {
    contextBarEl.style.width = `${Math.min(contextPct, 100)}%`;  // Bounded for bar
    contextBarEl.className = 'context-bar ' + (
        contextPct >= 80 ? 'context-high' :
        contextPct >= 50 ? 'context-medium' : 'context-low'
    );
}
if (contextPctEl) {
    contextPctEl.textContent = `${contextPct.toFixed(1)}%`;  // NOT bounded for text!
}
```

### Issues Identified
1. Hardcoded `context_window_size: int = 200_000` in `SDKOutput`
2. No bounding of percentage in Python calculations
3. Text display not bounded in `index.html` (bar is, but text isn't)
4. Same calculation logic repeated 3 times in Python

## 6. Proposed Solution

### 6.1 Architecture Overview

Create a new `src/jeeves/context/` module that centralizes all context tracking logic:

```
src/jeeves/
├── context/
│   ├── __init__.py          # Public exports
│   ├── service.py           # ContextService class
│   ├── models.py            # ContextStats, ModelInfo dataclasses
│   └── constants.py         # Model context window sizes
├── runner/
│   ├── output.py            # Uses ContextService for calculations
│   └── sdk_runner.py        # Uses ContextService for logging
└── viewer/
    └── static/index.html    # Display already bounded values
```

### 6.2 Detailed Design

#### 6.2.1 New Module: `src/jeeves/context/constants.py`

```python
"""Context window sizes for known models."""

# Context window sizes by model identifier
# Source: Anthropic model documentation
MODEL_CONTEXT_WINDOWS = {
    # Claude 4 family (current)
    "claude-sonnet-4-20250514": 200_000,
    "claude-opus-4-20250514": 200_000,

    # Claude 3.5 family
    "claude-3-5-sonnet-20241022": 200_000,
    "claude-3-5-haiku-20241022": 200_000,

    # Claude 3 family
    "claude-3-opus-20240229": 200_000,
    "claude-3-sonnet-20240229": 200_000,
    "claude-3-haiku-20240307": 200_000,

    # Aliases for convenience
    "claude-sonnet": 200_000,
    "claude-opus": 200_000,
    "claude-haiku": 200_000,
    "sonnet": 200_000,
    "opus": 200_000,
    "haiku": 200_000,
}

DEFAULT_CONTEXT_WINDOW = 200_000  # Fallback for unknown models
```

#### 6.2.2 New Module: `src/jeeves/context/models.py`

```python
"""Data models for context tracking."""

from dataclasses import dataclass
from typing import Optional


@dataclass
class TokenUsage:
    """Token usage from an SDK response."""
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_tokens: int = 0
    cache_read_tokens: int = 0

    @property
    def total_input(self) -> int:
        """Total input tokens including cache."""
        return self.input_tokens + self.cache_creation_tokens + self.cache_read_tokens

    @property
    def total(self) -> int:
        """Total tokens (input + output)."""
        return self.total_input + self.output_tokens


@dataclass
class ContextStats:
    """Statistics about context window usage."""
    percentage: float  # Bounded 0-100
    percentage_raw: float  # Unbounded (for diagnostics)
    total_input_tokens: int
    context_window_size: int
    is_near_limit: bool  # True if >= 80%
    is_over_limit: bool  # True if raw > 100%

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "percentage": self.percentage,
            "total_input_tokens": self.total_input_tokens,
            "context_window_size": self.context_window_size,
            "is_near_limit": self.is_near_limit,
        }
```

#### 6.2.3 New Module: `src/jeeves/context/service.py`

```python
"""Context tracking service."""

from typing import Optional
from .constants import MODEL_CONTEXT_WINDOWS, DEFAULT_CONTEXT_WINDOW
from .models import ContextStats, TokenUsage


class ContextService:
    """Service for tracking and calculating context window usage.

    Provides centralized, model-aware context tracking with proper
    bounds checking and formatted output.

    Example:
        service = ContextService(model="claude-sonnet")

        # Update from SDK usage data
        service.update(input_tokens=5000, output_tokens=1000)

        # Get bounded percentage
        pct = service.get_percentage()  # Returns 0-100

        # Get full stats
        stats = service.get_stats()
    """

    def __init__(self, model: str = "claude-sonnet"):
        """Initialize context service.

        Args:
            model: Model identifier to determine context window size.
                   Falls back to DEFAULT_CONTEXT_WINDOW if unknown.
        """
        self._model = model
        self._context_window = self._get_context_window(model)
        self._usage = TokenUsage()

    def _get_context_window(self, model: str) -> int:
        """Get context window size for a model."""
        # Try exact match first
        if model in MODEL_CONTEXT_WINDOWS:
            return MODEL_CONTEXT_WINDOWS[model]

        # Try prefix matching for versioned models
        model_lower = model.lower()
        for key, value in MODEL_CONTEXT_WINDOWS.items():
            if model_lower.startswith(key.lower()):
                return value

        return DEFAULT_CONTEXT_WINDOW

    @property
    def context_window_size(self) -> int:
        """Get the context window size for the current model."""
        return self._context_window

    @property
    def model(self) -> str:
        """Get the current model identifier."""
        return self._model

    def update(
        self,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_creation_tokens: int = 0,
        cache_read_tokens: int = 0,
    ) -> None:
        """Update token usage from SDK response.

        Args:
            input_tokens: Input tokens from this response
            output_tokens: Output tokens from this response
            cache_creation_tokens: Cache creation tokens
            cache_read_tokens: Cache read tokens
        """
        self._usage = TokenUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_creation_tokens=cache_creation_tokens,
            cache_read_tokens=cache_read_tokens,
        )

    def update_from_dict(self, usage: dict) -> None:
        """Update from SDK usage dictionary.

        Args:
            usage: Dictionary with keys like 'input_tokens', 'output_tokens', etc.
        """
        self.update(
            input_tokens=usage.get("input_tokens", 0),
            output_tokens=usage.get("output_tokens", 0),
            cache_creation_tokens=usage.get("cache_creation_input_tokens", 0),
            cache_read_tokens=usage.get("cache_read_input_tokens", 0),
        )

    def get_percentage(self) -> float:
        """Get bounded context percentage (0-100).

        Returns:
            Context usage as a percentage, bounded to 0-100 range.
        """
        return self.get_stats().percentage

    def get_percentage_raw(self) -> float:
        """Get unbounded context percentage.

        Returns:
            Raw context usage percentage (can exceed 100%).
        """
        if self._context_window <= 0:
            return 0.0
        return (self._usage.total_input / self._context_window) * 100

    def get_stats(self) -> ContextStats:
        """Get full context statistics.

        Returns:
            ContextStats with bounded percentage and diagnostic info.
        """
        raw_pct = self.get_percentage_raw()
        bounded_pct = max(0.0, min(100.0, raw_pct))

        return ContextStats(
            percentage=round(bounded_pct, 1),
            percentage_raw=round(raw_pct, 1),
            total_input_tokens=self._usage.total_input,
            context_window_size=self._context_window,
            is_near_limit=raw_pct >= 80.0,
            is_over_limit=raw_pct > 100.0,
        )

    def format_summary(self) -> str:
        """Format context usage for text output.

        Returns:
            Formatted string like "Context: 45.2% of 200K"
        """
        stats = self.get_stats()
        window_k = self._context_window // 1000
        pct_display = stats.percentage

        # Show warning if over limit
        if stats.is_over_limit:
            return f"Context: {pct_display:.1f}% of {window_k}K (WARNING: tokens exceed window)"

        return f"Context: {pct_display:.1f}% of {window_k}K"

    def reset(self) -> None:
        """Reset usage for a new session."""
        self._usage = TokenUsage()
```

#### 6.2.4 New Module: `src/jeeves/context/__init__.py`

```python
"""Context tracking module for Jeeves.

This module provides centralized context window tracking with:
- Model-aware context window sizes
- Bounded percentage calculations (0-100%)
- Formatted output for logs and UI
"""

from .constants import DEFAULT_CONTEXT_WINDOW, MODEL_CONTEXT_WINDOWS
from .models import ContextStats, TokenUsage
from .service import ContextService

__all__ = [
    "ContextService",
    "ContextStats",
    "TokenUsage",
    "MODEL_CONTEXT_WINDOWS",
    "DEFAULT_CONTEXT_WINDOW",
]
```

#### 6.2.5 Modifications to `output.py`

Update `SDKOutput` to use `ContextService`:

```python
# Add import at top
from ..context import ContextService

# In SDKOutput class, modify to_dict():
def to_dict(self) -> Dict[str, Any]:
    """Convert to dictionary for JSON serialization."""
    stats: Dict[str, Any] = {
        "message_count": self.message_count,
        "tool_call_count": self.tool_call_count,
        "duration_seconds": self.duration_seconds,
    }
    # Only include tokens if provider supports tracking (non-zero values)
    if self.input_tokens > 0 or self.output_tokens > 0:
        stats["tokens"] = {
            "input": self.input_tokens,
            "output": self.output_tokens,
            "cache_creation": self.cache_creation_tokens,
            "cache_read": self.cache_read_tokens,
        }
        # Use ContextService for bounded calculation
        context_svc = ContextService()  # TODO: Pass model from config
        context_svc.update(
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens,
            cache_creation_tokens=self.cache_creation_tokens,
            cache_read_tokens=self.cache_read_tokens,
        )
        context_stats = context_svc.get_stats()
        stats["context_percentage"] = context_stats.percentage
        stats["context_window_size"] = context_stats.context_window_size
    # ... rest unchanged
```

Similarly update `to_text()` to use `context_svc.format_summary()`.

#### 6.2.6 Modifications to `sdk_runner.py`

Update `_log_usage_summary()`:

```python
# Add import at top
from ..context import ContextService

# In _log_usage_summary():
def _log_usage_summary(self) -> None:
    """Log a friendly usage summary."""
    total = self.output.input_tokens + self.output.output_tokens
    self._log(
        f"[USAGE] Tokens: {self.output.input_tokens:,} in / "
        f"{self.output.output_tokens:,} out ({total:,} total)"
    )
    if self.output.cache_creation_tokens > 0 or self.output.cache_read_tokens > 0:
        self._log(
            f"[USAGE] Cache: {self.output.cache_creation_tokens:,} created / "
            f"{self.output.cache_read_tokens:,} read"
        )

    # Use ContextService for consistent calculation
    context_svc = ContextService()  # TODO: Pass model from config
    context_svc.update(
        input_tokens=self.output.input_tokens,
        output_tokens=self.output.output_tokens,
        cache_creation_tokens=self.output.cache_creation_tokens,
        cache_read_tokens=self.output.cache_read_tokens,
    )
    self._log(f"[USAGE] {context_svc.format_summary()}")

    if self.output.total_cost_usd is not None:
        self._log(f"[USAGE] Cost: ${self.output.total_cost_usd:.4f}")
```

#### 6.2.7 Modifications to `index.html`

Update the context display to handle the now-bounded percentage:

```javascript
// Lines ~1468-1479 - percentage is now already bounded from server
const contextPct = sdkOutput.stats?.context_percentage || 0;
if (contextBarEl) {
    contextBarEl.style.width = `${contextPct}%`;  // No Math.min needed - already bounded
    contextBarEl.className = 'context-bar ' + (
        contextPct >= 80 ? 'context-high' :
        contextPct >= 50 ? 'context-medium' : 'context-low'
    );
}
if (contextPctEl) {
    contextPctEl.textContent = `${contextPct.toFixed(1)}%`;  // Already bounded
}
```

### 6.3 Operational Considerations

#### Deployment
- No database migrations required
- Backward compatible with existing output files
- No new dependencies

#### Telemetry & Observability
- Context percentage now bounded ensures meaningful values
- `is_over_limit` flag available for diagnostic purposes

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| Create context module structure | Create `src/jeeves/context/` with `__init__.py` | Implementation Agent | None | Module importable |
| Implement constants.py | Define model context window sizes | Implementation Agent | Structure | Constants accessible |
| Implement models.py | Create TokenUsage and ContextStats dataclasses | Implementation Agent | Structure | Dataclasses work |
| Implement service.py | Create ContextService class | Implementation Agent | constants, models | Service functional |
| Write unit tests for context module | Test all context calculations | Test Agent | Full service | >90% coverage |
| Integrate into output.py | Remove duplication, use service | Implementation Agent | Service done | Tests pass |
| Integrate into sdk_runner.py | Use service for logging | Implementation Agent | Service done | Tests pass |
| Update index.html | Handle bounded percentages | Implementation Agent | Backend done | Display correct |

### 7.2 Milestones

**Phase 1: Core Service** (Issues 1-5)
- Create new module structure
- Implement all service functionality
- Comprehensive unit tests

**Phase 2: Integration** (Issues 6-8)
- Integrate service into existing code
- Update frontend display
- End-to-end testing

## 8. Agent Guidance & Guardrails

### Context Packets
- This design document
- Existing code files: `output.py`, `sdk_runner.py`, `index.html`
- Test patterns in `tests/test_runner_modules.py`

### Prompting & Constraints
- Follow existing code style (dataclasses, type hints)
- Use existing test pattern with `load_module_from_path`
- Commit style: conventional commits

### Safety Rails
- Do not modify JSON output schema structure
- Do not break existing viewer functionality
- Keep backward compatibility

### Validation Hooks
- Run `pytest tests/` before marking complete
- Verify context percentage is bounded in test output

## 9. Alternatives Considered

### Alternative 1: Add bounding in frontend only
- **Rejected**: Doesn't fix the root cause; duplication remains
- **Trade-off**: Simpler but technical debt persists

### Alternative 2: Pass model through config chain
- **Considered for future**: Currently model isn't passed through RunnerConfig
- **Trade-off**: More complex; would need to modify config across multiple files
- **Decision**: Use default model for now, add model parameter later

### Alternative 3: Real-time token estimation
- **Rejected as non-goal**: SDK doesn't provide streaming token counts
- **Trade-off**: Would require tiktoken or similar, adds complexity
- **Decision**: Document as future enhancement when SDK supports it

## 10. Testing & Validation Plan

### Unit Tests (`tests/test_context.py`)

```python
"""Tests for the context tracking module."""

class TestContextConstants:
    """Tests for context window constants."""

    def test_known_models_have_context_windows(self):
        """Verify all known models have defined context windows."""
        from jeeves.context import MODEL_CONTEXT_WINDOWS
        assert "claude-sonnet" in MODEL_CONTEXT_WINDOWS
        assert "claude-opus" in MODEL_CONTEXT_WINDOWS

class TestTokenUsage:
    """Tests for TokenUsage dataclass."""

    def test_total_input_calculation(self):
        """Verify total_input includes cache tokens."""
        from jeeves.context import TokenUsage
        usage = TokenUsage(
            input_tokens=1000,
            cache_creation_tokens=200,
            cache_read_tokens=300,
        )
        assert usage.total_input == 1500

class TestContextService:
    """Tests for ContextService."""

    def test_percentage_bounded_at_100(self):
        """Verify percentage never exceeds 100."""
        from jeeves.context import ContextService
        svc = ContextService()
        # Simulate tokens exceeding context window
        svc.update(input_tokens=300_000)
        assert svc.get_percentage() == 100.0
        assert svc.get_percentage_raw() > 100.0

    def test_percentage_bounded_at_0(self):
        """Verify percentage never goes below 0."""
        from jeeves.context import ContextService
        svc = ContextService()
        assert svc.get_percentage() == 0.0

    def test_model_context_window_lookup(self):
        """Verify correct context window for known models."""
        from jeeves.context import ContextService
        svc = ContextService(model="claude-sonnet")
        assert svc.context_window_size == 200_000

    def test_unknown_model_uses_default(self):
        """Verify unknown models use default context window."""
        from jeeves.context import ContextService, DEFAULT_CONTEXT_WINDOW
        svc = ContextService(model="unknown-model-xyz")
        assert svc.context_window_size == DEFAULT_CONTEXT_WINDOW

    def test_format_summary_normal(self):
        """Verify format_summary output."""
        from jeeves.context import ContextService
        svc = ContextService()
        svc.update(input_tokens=50_000)
        summary = svc.format_summary()
        assert "25.0%" in summary
        assert "200K" in summary

    def test_format_summary_over_limit(self):
        """Verify format_summary includes warning when over limit."""
        from jeeves.context import ContextService
        svc = ContextService()
        svc.update(input_tokens=250_000)
        summary = svc.format_summary()
        assert "WARNING" in summary

    def test_stats_is_near_limit(self):
        """Verify is_near_limit flag at 80%."""
        from jeeves.context import ContextService
        svc = ContextService()
        svc.update(input_tokens=160_000)  # 80%
        stats = svc.get_stats()
        assert stats.is_near_limit is True

    def test_update_from_dict(self):
        """Verify update_from_dict handles SDK format."""
        from jeeves.context import ContextService
        svc = ContextService()
        svc.update_from_dict({
            "input_tokens": 1000,
            "output_tokens": 500,
            "cache_creation_input_tokens": 100,
            "cache_read_input_tokens": 50,
        })
        assert svc._usage.total_input == 1150
```

### Integration Tests
- Verify `SDKOutput.to_dict()` produces bounded percentages
- Verify `SDKOutput.to_text()` shows correct context line
- Verify viewer displays correctly with edge cases (0%, 50%, 100%)

## 11. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Model parameter not available in current flow | High | Low | Use default; add model param to RunnerConfig later |
| Breaking existing tests | Medium | Medium | Run full test suite before and after changes |
| Frontend not handling bounded values | Low | Low | Values were already mostly bounded; this is a simplification |

## 12. Rollout Plan

### Phase 1: Create Module
1. Create `src/jeeves/context/` module
2. Write unit tests
3. Verify module is importable

### Phase 2: Integration
1. Integrate into `output.py`
2. Integrate into `sdk_runner.py`
3. Update `index.html`
4. Run full test suite

### Phase 3: Verification
1. Run sample SDK sessions
2. Verify context displays correctly
3. Check edge cases (high usage, zero usage)

## 13. Open Questions

1. **Q**: Should we add the model parameter to `RunnerConfig` now or later?
   - **Proposed**: Later - keep this PR focused on the service extraction

2. **Q**: Should we emit events for real-time context updates?
   - **Proposed**: Not now - SDK doesn't provide streaming tokens; prepare architecture for future

3. **Q**: Should `is_over_limit` be exposed in JSON output?
   - **Proposed**: Not in initial version - keep output schema stable

## 14. Follow-Up Work

- [ ] Add model parameter to `RunnerConfig` for accurate context window
- [ ] Research SDK streaming token capabilities for future releases
- [ ] Add context alerts/notifications when approaching limit
- [ ] Consider adding context trend visualization in viewer

## 15. References

- Issue #19: [Improve context tracking](https://github.com/hansjm10/jeeves/issues/19)
- `src/jeeves/runner/output.py` - Current context calculation
- `src/jeeves/runner/sdk_runner.py` - Current logging
- `src/jeeves/viewer/static/index.html` - Current display

## Appendix A - Glossary

| Term | Definition |
|------|------------|
| Context Window | Maximum tokens a model can process in a single conversation |
| Cache Tokens | Tokens stored/retrieved from prompt caching |
| Token | Basic unit of text processing (roughly 4 characters) |
| SDK | Claude Agent SDK used for running agents |

## Appendix B - Change Log

| Date | Author | Change Summary |
|------|--------|----------------|
| 2025-01-29 | Jeeves AI Agent | Initial draft |
