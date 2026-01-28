"""Provider abstraction for Jeeves output adapters.

This package contains the OutputProvider base class and implementations
for different AI SDK backends (Claude SDK, Codex, OpenCode, etc.).
"""

from jeeves.runner.providers.base import OutputProvider

__all__ = ["OutputProvider"]
