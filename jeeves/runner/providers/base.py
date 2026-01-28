"""Base class for Jeeves output providers.

This module defines the OutputProvider abstract base class that all
provider adapters must implement.
"""

from abc import ABC, abstractmethod
from typing import Any, Dict

from jeeves.runner.output import Message


class OutputProvider(ABC):
    """Abstract base class for SDK output providers.

    Providers are adapters that convert SDK-specific events into the
    standardized jeeves.output.v2 format. Each provider handles a
    specific AI SDK (e.g., Claude SDK, Codex, OpenCode).

    To create a new provider:
    1. Subclass OutputProvider
    2. Implement parse_event() to convert SDK events to Message objects
    3. Implement get_provider_info() to return provider metadata
    4. Set supports_tokens to indicate token tracking capability

    Example:
        class MyProvider(OutputProvider):
            def parse_event(self, event):
                return Message(type="assistant", content=event.text)

            def get_provider_info(self):
                return {"name": "my-sdk", "version": "1.0.0", "metadata": {}}

            @property
            def supports_tokens(self) -> bool:
                return True
    """

    @abstractmethod
    def parse_event(self, event: Any) -> Message:
        """Parse a provider-specific event into a Message.

        Args:
            event: A provider-specific event object. The type and structure
                depends on the SDK being adapted.

        Returns:
            Message: A standardized Message object for the conversation.

        Raises:
            ValueError: If the event cannot be parsed into a valid Message.
        """
        pass

    @abstractmethod
    def get_provider_info(self) -> Dict[str, Any]:
        """Return provider metadata.

        Returns:
            Dict with provider information matching the v2 schema:
            {
                "name": str,      # Provider name (e.g., "claude-sdk")
                "version": str,   # Provider/SDK version string
                "metadata": dict  # Additional provider-specific metadata
            }
        """
        pass

    @property
    @abstractmethod
    def supports_tokens(self) -> bool:
        """Whether this provider reports token usage.

        Returns:
            True if the provider can track input/output token counts,
            False otherwise.

        Some providers may not support token tracking, in which case
        the token counts in the output will be omitted or set to 0.
        """
        pass
