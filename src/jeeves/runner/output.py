"""Output formatting for the Jeeves SDK Runner."""

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..context import ContextService


@dataclass
class ToolCall:
    """Record of a tool call."""

    name: str
    input: Dict[str, Any]
    tool_use_id: str
    duration_ms: Optional[int] = None
    result: Optional[str] = None
    is_error: bool = False
    timestamp: str = ""

    def to_dict(self) -> Dict[str, Any]:
        d = {
            "name": self.name,
            "input": self.input,
            "tool_use_id": self.tool_use_id,
        }
        if self.duration_ms is not None:
            d["duration_ms"] = self.duration_ms
        if self.timestamp:
            d["timestamp"] = self.timestamp
        if self.is_error:
            d["is_error"] = self.is_error
        return d


@dataclass
class Message:
    """A message from the SDK."""

    type: str  # "system", "assistant", "tool_result", "result", "user"
    content: Optional[str] = None
    subtype: Optional[str] = None  # For system messages: "init", "error", etc.
    tool_use: Optional[Dict[str, Any]] = None  # {name, input, id}
    tool_use_id: Optional[str] = None  # For tool_result messages
    session_id: Optional[str] = None
    timestamp: str = ""
    raw: Optional[Dict[str, Any]] = None  # Original message from SDK

    def to_dict(self) -> Dict[str, Any]:
        d = {"type": self.type, "timestamp": self.timestamp}
        if self.content is not None:
            d["content"] = self.content
        if self.subtype:
            d["subtype"] = self.subtype
        if self.tool_use:
            d["tool_use"] = self.tool_use
        if self.tool_use_id:
            d["tool_use_id"] = self.tool_use_id
        if self.session_id:
            d["session_id"] = self.session_id
        return d


@dataclass
class SDKOutput:
    """Complete output from an SDK run."""

    schema: str = "jeeves.sdk.v1"
    session_id: Optional[str] = None
    started_at: str = ""
    ended_at: str = ""
    success: bool = False

    # Iteration tracking (for Ralph Wiggum pattern)
    iteration: int = 1  # Which iteration this run is (1-indexed)

    messages: List[Message] = field(default_factory=list)
    tool_calls: List[ToolCall] = field(default_factory=list)

    # Statistics
    message_count: int = 0
    tool_call_count: int = 0
    duration_seconds: float = 0.0

    # Token usage tracking (when provider supports it)
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_tokens: int = 0
    cache_read_tokens: int = 0
    total_cost_usd: Optional[float] = None
    context_window_size: int = 200_000  # Default for Claude Sonnet

    # Error info
    error: Optional[str] = None
    error_type: Optional[str] = None

    def add_message(self, msg: Message) -> None:
        """Add a message to the output."""
        if not msg.timestamp:
            msg.timestamp = datetime.now(timezone.utc).isoformat()
        self.messages.append(msg)
        self.message_count += 1

    def add_tool_call(self, call: ToolCall) -> None:
        """Add a tool call to the output."""
        if not call.timestamp:
            call.timestamp = datetime.now(timezone.utc).isoformat()
        self.tool_calls.append(call)
        self.tool_call_count += 1

    def finalize(self, success: bool, error: Optional[str] = None) -> None:
        """Finalize the output with end time and success status."""
        self.ended_at = datetime.now(timezone.utc).isoformat()
        self.success = success
        self.error = error

        if self.started_at and self.ended_at:
            try:
                start = datetime.fromisoformat(self.started_at.replace("Z", "+00:00"))
                end = datetime.fromisoformat(self.ended_at.replace("Z", "+00:00"))
                self.duration_seconds = (end - start).total_seconds()
            except (ValueError, TypeError):
                pass

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
            context_svc = ContextService()
            context_svc.update(
                input_tokens=self.input_tokens,
                output_tokens=self.output_tokens,
                cache_creation_tokens=self.cache_creation_tokens,
                cache_read_tokens=self.cache_read_tokens,
            )
            context_stats = context_svc.get_stats()
            stats["context_percentage"] = context_stats.percentage
            stats["context_window_size"] = context_stats.context_window_size
        # Include cost when available
        if self.total_cost_usd is not None:
            stats["cost_usd"] = self.total_cost_usd
        return {
            "schema": self.schema,
            "session_id": self.session_id,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "success": self.success,
            "iteration": self.iteration,
            "messages": [m.to_dict() for m in self.messages],
            "tool_calls": [t.to_dict() for t in self.tool_calls],
            "stats": stats,
            "error": self.error,
            "error_type": self.error_type,
        }

    def to_json(self, indent: int = 2) -> str:
        """Convert to JSON string."""
        return json.dumps(self.to_dict(), indent=indent)

    def save(self, path: Path) -> None:
        """Save to a JSON file."""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.to_json())

    def to_text(self) -> str:
        """Convert to plain text output for backward compatibility.

        This generates output similar to what the CLI runner produces.
        """
        lines: List[str] = []

        for msg in self.messages:
            if msg.type == "assistant":
                if msg.content:
                    lines.append(msg.content)
                if msg.tool_use:
                    tool_name = msg.tool_use.get("name", "unknown")
                    tool_input = msg.tool_use.get("input", {})

                    # Format tool calls similar to CLI output
                    if tool_name == "Bash":
                        cmd = tool_input.get("command", "")
                        lines.append(f"exec: {cmd}")
                    elif tool_name in ("Write", "Edit"):
                        file_path = tool_input.get("file_path", "")
                        lines.append(f"file update: {file_path}")
                    elif tool_name == "Read":
                        file_path = tool_input.get("file_path", "")
                        lines.append(f"file read: {file_path}")
                    else:
                        lines.append(f"tool: {tool_name}")

            elif msg.type == "tool_result":
                # Include significant tool results (errors, etc.)
                if msg.content and "[ERROR]" in str(msg.content):
                    lines.append(f"[TOOL ERROR] {msg.content[:500]}")

            elif msg.type == "result":
                if msg.content:
                    lines.append("")
                    lines.append("--- Final Result ---")
                    lines.append(msg.content)

        # Append usage summary if token data is available
        if self.input_tokens > 0 or self.output_tokens > 0:
            lines.append("")
            lines.append("--- Usage Summary ---")
            total_tokens = self.input_tokens + self.output_tokens
            lines.append(
                f"Tokens: {self.input_tokens:,} in / {self.output_tokens:,} out ({total_tokens:,} total)"
            )
            if self.cache_creation_tokens > 0 or self.cache_read_tokens > 0:
                lines.append(
                    f"Cache: {self.cache_creation_tokens:,} created / {self.cache_read_tokens:,} read"
                )
            # Use ContextService for consistent, bounded calculation
            context_svc = ContextService()
            context_svc.update(
                input_tokens=self.input_tokens,
                output_tokens=self.output_tokens,
                cache_creation_tokens=self.cache_creation_tokens,
                cache_read_tokens=self.cache_read_tokens,
            )
            lines.append(context_svc.format_summary())
            if self.total_cost_usd is not None:
                lines.append(f"Cost: ${self.total_cost_usd:.4f}")

        return "\n".join(lines)

    def save_text(self, path: Path) -> None:
        """Save plain text output."""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.to_text())


def create_output() -> SDKOutput:
    """Create a new SDK output instance."""
    output = SDKOutput()
    output.started_at = datetime.now(timezone.utc).isoformat()
    return output
