"""ClaudeSDKProvider adapter for Claude Agent SDK.

This module implements the OutputProvider interface for the Claude Agent SDK,
converting SDK-specific events into the standardized jeeves.output.v2 format.
"""

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from ..output import Message
from .base import OutputProvider


def _get_claude_sdk_version() -> str:
    """Get the claude-agent-sdk version if installed.

    Returns:
        Version string if available, "unknown" otherwise.
    """
    try:
        from claude_agent_sdk import __version__

        return __version__
    except (ImportError, AttributeError):
        # SDK not installed or doesn't expose version
        try:
            # Try importlib.metadata as fallback
            from importlib.metadata import version

            return version("claude-agent-sdk")
        except Exception:
            return "unknown"


class ClaudeSDKProvider(OutputProvider):
    """Provider adapter for Claude Agent SDK.

    Converts Claude SDK events into the standardized jeeves.output.v2 format
    while maintaining backward compatibility with v1 schema.

    Example:
        provider = ClaudeSDKProvider()
        info = provider.get_provider_info()
        # {"name": "claude-sdk", "version": "1.0.0", "metadata": {}}

        event = {"type": "assistant", "content": [{"type": "text", "text": "Hello"}]}
        msg = provider.parse_event(event)
        # Message(type="assistant", content="Hello", ...)
    """

    def __init__(self) -> None:
        """Initialize the ClaudeSDKProvider."""
        self._sdk_version: Optional[str] = None

    @property
    def sdk_version(self) -> str:
        """Get the Claude SDK version (cached)."""
        if self._sdk_version is None:
            self._sdk_version = _get_claude_sdk_version()
        return self._sdk_version

    def get_provider_info(self) -> Dict[str, Any]:
        """Return provider metadata.

        Returns:
            Dict with provider information:
            {
                "name": "claude-sdk",
                "version": <claude-agent-sdk version>,
                "metadata": {}
            }
        """
        return {
            "name": "claude-sdk",
            "version": self.sdk_version,
            "metadata": {},
        }

    @property
    def supports_tokens(self) -> bool:
        """Whether this provider reports token usage.

        The Claude Agent SDK currently does not expose token usage
        information through its streaming interface.

        Returns:
            False - token tracking not supported yet.
        """
        return False

    def parse_event(self, event: Any) -> Message:
        """Parse a Claude SDK event into a Message.

        Handles various event types from the Claude Agent SDK:
        - System messages (init, error)
        - Assistant messages (text content, tool use)
        - User messages (tool results)
        - Result messages (success, error)

        Args:
            event: A dict representing a Claude SDK event.

        Returns:
            Message: A standardized Message object.

        Raises:
            ValueError: If the event cannot be parsed.
        """
        if not isinstance(event, dict):
            raise ValueError(f"Expected dict event, got {type(event).__name__}")

        event_type = event.get("type")
        if not event_type:
            raise ValueError("Event missing 'type' field")

        timestamp = datetime.now(timezone.utc).isoformat()

        # Handle different event types
        if event_type == "system":
            return self._parse_system_event(event, timestamp)
        elif event_type == "assistant":
            return self._parse_assistant_event(event, timestamp)
        elif event_type == "user":
            return self._parse_user_event(event, timestamp)
        elif event_type == "result":
            return self._parse_result_event(event, timestamp)
        else:
            # Unknown type - return as-is
            return Message(
                type=event_type,
                content=str(event),
                timestamp=timestamp,
            )

    def _parse_system_event(self, event: Dict[str, Any], timestamp: str) -> Message:
        """Parse a system event (init, error, etc.)."""
        subtype = event.get("subtype")
        data = event.get("data", {})
        session_id = data.get("session_id") if isinstance(data, dict) else None
        content = event.get("content")

        return Message(
            type="system",
            subtype=subtype,
            session_id=session_id,
            content=content,
            timestamp=timestamp,
        )

    def _parse_assistant_event(self, event: Dict[str, Any], timestamp: str) -> Message:
        """Parse an assistant event (text content, tool use)."""
        content_blocks = event.get("content", [])
        text_content: Optional[str] = None
        tool_use: Optional[Dict[str, Any]] = None

        if isinstance(content_blocks, list):
            text_parts: List[str] = []
            for block in content_blocks:
                if isinstance(block, dict):
                    block_type = block.get("type")
                    if block_type == "text":
                        text_parts.append(block.get("text", ""))
                    elif block_type == "tool_use":
                        tool_use = {
                            "name": block.get("name"),
                            "input": block.get("input", {}),
                            "id": block.get("id"),
                        }
            if text_parts:
                text_content = "\n".join(text_parts)
        elif isinstance(content_blocks, str):
            text_content = content_blocks

        return Message(
            type="assistant",
            content=text_content,
            tool_use=tool_use,
            timestamp=timestamp,
        )

    def _parse_user_event(self, event: Dict[str, Any], timestamp: str) -> Message:
        """Parse a user event (typically tool result)."""
        content_blocks = event.get("content", [])

        # Check for tool_result block
        if isinstance(content_blocks, list):
            for block in content_blocks:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    tool_use_id = block.get("tool_use_id")
                    content = block.get("content")
                    if isinstance(content, str):
                        pass  # Keep as-is
                    elif content is not None:
                        content = str(content)

                    return Message(
                        type="tool_result",
                        tool_use_id=tool_use_id,
                        content=content,
                        timestamp=timestamp,
                    )

        # Regular user message
        content = self._extract_text_content(content_blocks)
        return Message(
            type="user",
            content=content,
            timestamp=timestamp,
        )

    def _parse_result_event(self, event: Dict[str, Any], timestamp: str) -> Message:
        """Parse a result event (success, error)."""
        subtype = event.get("subtype")
        result = event.get("result")

        return Message(
            type="result",
            subtype=subtype,
            content=result,
            timestamp=timestamp,
        )

    def _extract_text_content(self, content: Any) -> Optional[str]:
        """Extract text content from various formats."""
        if content is None:
            return None
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            text_parts: List[str] = []
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        text_parts.append(block.get("text", ""))
                elif isinstance(block, str):
                    text_parts.append(block)
            return "\n".join(text_parts) if text_parts else None
        return str(content)
