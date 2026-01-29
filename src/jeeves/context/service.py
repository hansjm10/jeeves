"""Context tracking service."""

from .constants import DEFAULT_CONTEXT_WINDOW, MODEL_CONTEXT_WINDOWS
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
