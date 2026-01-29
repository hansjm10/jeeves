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
