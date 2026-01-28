"""Provider abstraction for Jeeves output adapters.

This package contains the OutputProvider base class and implementations
for different AI SDK backends (Claude SDK, Codex, OpenCode, etc.).
"""

from .base import OutputProvider
from .claude_sdk import ClaudeSDKProvider

__all__ = ["OutputProvider", "ClaudeSDKProvider"]
