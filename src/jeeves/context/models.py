"""Data models for context tracking."""

from dataclasses import dataclass
from typing import Any


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

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "percentage": self.percentage,
            "total_input_tokens": self.total_input_tokens,
            "context_window_size": self.context_window_size,
            "is_near_limit": self.is_near_limit,
        }
