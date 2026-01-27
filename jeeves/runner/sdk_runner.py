#!/usr/bin/env python3
"""
Jeeves SDK Runner - Main entry point using claude-agent-sdk.

This runner uses the Claude Agent SDK for structured output, better logging,
and programmatic control of the agent.
"""

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# Import the SDK
try:
    from claude_agent_sdk import ClaudeAgentOptions, query
except ImportError:
    # Provide helpful error message
    print("Error: claude-agent-sdk not installed.", file=sys.stderr)
    print("Install with: pip install claude-agent-sdk", file=sys.stderr)
    sys.exit(1)

from .config import RunnerConfig
from .output import Message, SDKOutput, ToolCall, create_output


class SDKRunner:
    """Runner that uses the Claude Agent SDK."""

    def __init__(self, config: RunnerConfig):
        self.config = config
        self.output: SDKOutput = create_output()
        self._tool_start_times: Dict[str, float] = {}
        self._pending_tool_calls: Dict[str, ToolCall] = {}

    async def run(self) -> SDKOutput:
        """Run the agent with the given prompt and collect output."""
        # Read the prompt
        if not self.config.prompt_file.exists():
            self.output.error = f"Prompt file not found: {self.config.prompt_file}"
            self.output.error_type = "FileNotFoundError"
            self.output.finalize(success=False, error=self.output.error)
            return self.output

        prompt = self.config.prompt_file.read_text()

        # Build options
        options = ClaudeAgentOptions(
            allowed_tools=self.config.allowed_tools,
            permission_mode=self.config.permission_mode,
            cwd=str(self.config.work_dir),
        )

        # Add max_turns if specified
        if self.config.max_turns:
            options.max_turns = self.config.max_turns

        # Track session initialization
        self.output.add_message(
            Message(
                type="system",
                subtype="init",
                content=f"Starting SDK runner with prompt from {self.config.prompt_file}",
                timestamp=datetime.now(timezone.utc).isoformat(),
            )
        )

        try:
            # Run the agent
            async for message in query(prompt=prompt, options=options):
                self._process_message(message)

            self.output.finalize(success=True)

        except Exception as e:
            self.output.error = str(e)
            self.output.error_type = type(e).__name__
            self.output.add_message(
                Message(
                    type="system",
                    subtype="error",
                    content=f"Agent error: {e}",
                    timestamp=datetime.now(timezone.utc).isoformat(),
                )
            )
            self.output.finalize(success=False, error=str(e))

        return self.output

    def _process_message(self, message: Any) -> None:
        """Process a message from the SDK generator."""
        import time

        now = datetime.now(timezone.utc).isoformat()

        # The SDK yields various message types
        # Handle based on the message structure
        msg_type = getattr(message, "type", None) or message.get("type", "unknown") if isinstance(message, dict) else "unknown"

        if msg_type == "system":
            # System messages (session init, etc.)
            session_id = getattr(message, "session_id", None)
            if session_id:
                self.output.session_id = session_id
            self.output.add_message(
                Message(
                    type="system",
                    subtype=getattr(message, "subtype", None),
                    session_id=session_id,
                    timestamp=now,
                    raw=self._to_dict(message),
                )
            )

        elif msg_type == "assistant":
            # Assistant messages may contain content and/or tool_use
            content = self._get_content(message)
            tool_use = self._get_tool_use(message)

            self.output.add_message(
                Message(
                    type="assistant",
                    content=content,
                    tool_use=tool_use,
                    timestamp=now,
                    raw=self._to_dict(message),
                )
            )

            # Track tool call start
            if tool_use:
                tool_id = tool_use.get("id", "")
                if tool_id:
                    self._tool_start_times[tool_id] = time.time()
                    self._pending_tool_calls[tool_id] = ToolCall(
                        name=tool_use.get("name", "unknown"),
                        input=tool_use.get("input", {}),
                        tool_use_id=tool_id,
                        timestamp=now,
                    )

        elif msg_type == "tool_result":
            # Tool result messages
            tool_use_id = getattr(message, "tool_use_id", None) or (message.get("tool_use_id") if isinstance(message, dict) else None)
            content = self._get_content(message)
            is_error = getattr(message, "is_error", False) or (message.get("is_error", False) if isinstance(message, dict) else False)

            self.output.add_message(
                Message(
                    type="tool_result",
                    tool_use_id=tool_use_id,
                    content=content[:2000] if content and len(content) > 2000 else content,  # Truncate large results
                    timestamp=now,
                    raw=self._to_dict(message),
                )
            )

            # Record completed tool call
            if tool_use_id and tool_use_id in self._pending_tool_calls:
                tool_call = self._pending_tool_calls.pop(tool_use_id)
                start_time = self._tool_start_times.pop(tool_use_id, None)
                if start_time:
                    tool_call.duration_ms = int((time.time() - start_time) * 1000)
                tool_call.is_error = is_error
                self.output.add_tool_call(tool_call)

        elif msg_type == "result":
            # Final result message
            content = self._get_content(message)
            self.output.add_message(
                Message(
                    type="result",
                    content=content,
                    timestamp=now,
                    raw=self._to_dict(message),
                )
            )

        elif msg_type == "user":
            # User messages (typically just the initial prompt)
            content = self._get_content(message)
            self.output.add_message(
                Message(
                    type="user",
                    content=content,
                    timestamp=now,
                    raw=self._to_dict(message),
                )
            )

        else:
            # Unknown message type - still record it
            self.output.add_message(
                Message(
                    type=msg_type if isinstance(msg_type, str) else "unknown",
                    content=str(message)[:500],
                    timestamp=now,
                    raw=self._to_dict(message),
                )
            )

    def _get_content(self, message: Any) -> Optional[str]:
        """Extract content from a message."""
        if isinstance(message, dict):
            content = message.get("content")
        else:
            content = getattr(message, "content", None)

        if content is None:
            return None

        # Content might be a list of content blocks
        if isinstance(content, list):
            text_parts = []
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        text_parts.append(block.get("text", ""))
                elif isinstance(block, str):
                    text_parts.append(block)
                elif hasattr(block, "text"):
                    text_parts.append(block.text)
            return "\n".join(text_parts) if text_parts else None

        if isinstance(content, str):
            return content

        return str(content)

    def _get_tool_use(self, message: Any) -> Optional[Dict[str, Any]]:
        """Extract tool_use from a message."""
        if isinstance(message, dict):
            content = message.get("content", [])
        else:
            content = getattr(message, "content", [])

        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    return {
                        "name": block.get("name"),
                        "input": block.get("input", {}),
                        "id": block.get("id"),
                    }
                elif hasattr(block, "type") and block.type == "tool_use":
                    return {
                        "name": block.name,
                        "input": getattr(block, "input", {}),
                        "id": block.id,
                    }

        return None

    def _to_dict(self, obj: Any) -> Optional[Dict[str, Any]]:
        """Convert an object to a dict for raw storage."""
        if isinstance(obj, dict):
            return obj
        if hasattr(obj, "__dict__"):
            return {k: v for k, v in obj.__dict__.items() if not k.startswith("_")}
        if hasattr(obj, "model_dump"):  # Pydantic v2
            return obj.model_dump()
        if hasattr(obj, "dict"):  # Pydantic v1
            return obj.dict()
        return None


async def run_agent(config: RunnerConfig) -> SDKOutput:
    """Run the agent with the given configuration."""
    runner = SDKRunner(config)
    return await runner.run()


def main() -> int:
    """Main entry point for the SDK runner."""
    parser = argparse.ArgumentParser(
        description="Jeeves SDK Runner - Run Claude agent using the Agent SDK"
    )
    parser.add_argument(
        "--prompt",
        "-p",
        required=True,
        help="Path to the prompt file",
    )
    parser.add_argument(
        "--output",
        "-o",
        required=True,
        help="Path for the JSON output file",
    )
    parser.add_argument(
        "--text-output",
        "-t",
        help="Path for plain text output (for backward compatibility)",
    )
    parser.add_argument(
        "--work-dir",
        "-w",
        help="Working directory for the agent",
    )
    parser.add_argument(
        "--state-dir",
        "-s",
        help="Jeeves state directory",
    )
    parser.add_argument(
        "--max-turns",
        type=int,
        help="Maximum number of agent turns",
    )
    parser.add_argument(
        "--allowed-tools",
        help="Comma-separated list of allowed tools",
    )

    args = parser.parse_args()

    # Parse allowed tools
    allowed_tools = None
    if args.allowed_tools:
        allowed_tools = [t.strip() for t in args.allowed_tools.split(",")]

    config = RunnerConfig.from_args(
        prompt=args.prompt,
        output=args.output,
        text_output=args.text_output,
        work_dir=args.work_dir,
        state_dir=args.state_dir,
        allowed_tools=allowed_tools,
        max_turns=args.max_turns,
    )

    # Run the agent
    output = asyncio.run(run_agent(config))

    # Save outputs
    output.save(config.output_file)

    if config.text_output_file:
        output.save_text(config.text_output_file)

    # Print summary to stderr
    print(f"[SDK Runner] Session: {output.session_id}", file=sys.stderr)
    print(f"[SDK Runner] Messages: {output.message_count}", file=sys.stderr)
    print(f"[SDK Runner] Tool calls: {output.tool_call_count}", file=sys.stderr)
    print(f"[SDK Runner] Duration: {output.duration_seconds:.1f}s", file=sys.stderr)
    print(f"[SDK Runner] Success: {output.success}", file=sys.stderr)
    if output.error:
        print(f"[SDK Runner] Error: {output.error}", file=sys.stderr)

    return 0 if output.success else 1


if __name__ == "__main__":
    sys.exit(main())
