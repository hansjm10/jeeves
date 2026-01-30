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
    from claude_agent_sdk.types import (
        AssistantMessage,
        ResultMessage,
        StreamEvent,
        SystemMessage,
        TextBlock,
        ToolResultBlock,
        ToolUseBlock,
        UserMessage,
    )
except ImportError:
    # Provide helpful error message
    print("Error: claude-agent-sdk not installed.", file=sys.stderr)
    print("Install with: pip install claude-agent-sdk", file=sys.stderr)
    sys.exit(1)

from ..context import ContextService
from ..skills.manager import SkillManager
from .config import RunnerConfig
from .output import Message, SDKOutput, ToolCall, create_output


class SDKRunner:
    """Runner that uses the Claude Agent SDK."""

    def __init__(self, config: RunnerConfig):
        self.config = config
        self.output: SDKOutput = create_output()
        self._tool_start_times: Dict[str, float] = {}
        self._pending_tool_calls: Dict[str, ToolCall] = {}
        self._log_file = None
        self._last_save_time: float = 0
        self._save_interval: float = 2.0  # Save every 2 seconds max

        # Initialize skill manager if skills_source is configured
        self._skill_manager: Optional[SkillManager] = None
        if config.skills_source:
            self._skill_manager = SkillManager(
                skills_source=config.skills_source,
            )

    def _save_output_incremental(self, force: bool = False) -> None:
        """Save output file incrementally for real-time viewer updates."""
        import time
        now = time.time()
        # Save if forced or if enough time has passed since last save
        if force or (now - self._last_save_time >= self._save_interval):
            try:
                self.output.save(self.config.output_file)
                self._last_save_time = now
            except Exception as e:
                # Log but don't fail on save errors
                self._log(f"[WARNING] Failed to save output: {e}")

    def _open_log_file(self) -> None:
        """Open the text log file for streaming output."""
        if self.config.text_output_file:
            self.config.text_output_file.parent.mkdir(parents=True, exist_ok=True)
            self._log_file = open(self.config.text_output_file, "w", buffering=1)  # Line buffered

    def _close_log_file(self) -> None:
        """Close the text log file."""
        if self._log_file:
            self._log_file.close()
            self._log_file = None

    def _log(self, line: str) -> None:
        """Write a line to the log file immediately."""
        if self._log_file:
            self._log_file.write(line + "\n")
            self._log_file.flush()

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
        # Use ContextService for consistent, bounded calculation
        context_svc = ContextService()
        context_svc.update(
            input_tokens=self.output.input_tokens,
            output_tokens=self.output.output_tokens,
            cache_creation_tokens=self.output.cache_creation_tokens,
            cache_read_tokens=self.output.cache_read_tokens,
        )
        self._log(f"[USAGE] {context_svc.format_summary()}")
        if self.output.total_cost_usd is not None:
            self._log(f"[USAGE] Cost: ${self.output.total_cost_usd:.4f}")

    async def run(self) -> SDKOutput:
        """Run the agent with the given prompt and collect output."""
        # Open log file for streaming
        self._open_log_file()

        try:
            return await self._run_internal()
        finally:
            self._close_log_file()

    async def _run_internal(self) -> SDKOutput:
        """Internal run implementation."""
        # Read the prompt
        if not self.config.prompt_file.exists():
            self.output.error = f"Prompt file not found: {self.config.prompt_file}"
            self.output.error_type = "FileNotFoundError"
            self._log(f"[ERROR] Prompt file not found: {self.config.prompt_file}")
            self.output.finalize(success=False, error=self.output.error)
            return self.output

        prompt = self.config.prompt_file.read_text()

        # Provision phase-specific skills
        provisioned_skills: List[str] = []
        if self._skill_manager and self.config.phase and self.config.phase_type:
            provisioned_skills = self._skill_manager.provision_skills(
                target_dir=self.config.work_dir,
                phase=self.config.phase,
                phase_type=self.config.phase_type,
            )
            self._log(f"[SKILLS] Provisioned for {self.config.phase}: {provisioned_skills}")

        # Build allowed_tools list - add Skill tool if skills were provisioned
        allowed_tools = list(self.config.allowed_tools)
        if provisioned_skills:
            if "Skill" not in allowed_tools:
                allowed_tools.append("Skill")

        # Build options with streaming enabled
        options = ClaudeAgentOptions(
            allowed_tools=allowed_tools,
            permission_mode=self.config.permission_mode,
            cwd=str(self.config.work_dir),
            include_partial_messages=True,  # Enable streaming
            max_buffer_size=self.config.max_buffer_size,
            # Enable project skills discovery when skills are provisioned
            setting_sources=["project"] if provisioned_skills else None,
        )

        # Track session initialization
        self._log(f"[SDK] Starting with prompt from {self.config.prompt_file}")
        self.output.add_message(
            Message(
                type="system",
                subtype="init",
                content=f"Starting SDK runner with prompt from {self.config.prompt_file}",
                timestamp=datetime.now(timezone.utc).isoformat(),
            )
        )

        try:
            import time
            # Inactivity detection threshold (10 minutes)
            INACTIVITY_TIMEOUT = 600

            # Run the agent with inactivity detection
            last_message_time = time.time()

            async for message in query(prompt=prompt, options=options):
                current_time = time.time()

                # Log if there's excessive delay between messages
                delay = current_time - last_message_time
                if delay > INACTIVITY_TIMEOUT:
                    self._log(
                        f"[WARNING] Long delay detected: {delay:.1f}s since last message"
                    )

                last_message_time = current_time
                self._process_message(message)
                # Periodically save output for real-time viewer updates
                self._save_output_incremental()

            self._log("")  # Newline after streamed content
            self._log("[SDK] Run completed successfully")
            self.output.finalize(success=True)
            # Final save after completion
            self._save_output_incremental(force=True)

        except Exception as e:
            self.output.error = str(e)
            self.output.error_type = type(e).__name__
            self._log(f"[ERROR] Agent error: {e}")
            self.output.add_message(
                Message(
                    type="system",
                    subtype="error",
                    content=f"Agent error: {e}",
                    timestamp=datetime.now(timezone.utc).isoformat(),
                )
            )
            self.output.finalize(success=False, error=str(e))
            # Final save after error
            self._save_output_incremental(force=True)

        return self.output

    def _process_message(self, message: Any) -> None:
        """Process a message from the SDK generator."""
        try:
            self._process_message_internal(message)
        except Exception as e:
            self._log(f"[ERROR] Failed to process message: {e}")
            self.output.add_message(
                Message(
                    type="system",
                    subtype="error",
                    content=f"Message processing error: {e}",
                    timestamp=datetime.now(timezone.utc).isoformat(),
                )
            )

    def _process_message_internal(self, message: Any) -> None:
        """Internal message processing implementation."""
        import time

        now = datetime.now(timezone.utc).isoformat()

        # The SDK yields typed dataclass messages - use isinstance checks
        if isinstance(message, SystemMessage):
            # System messages (session init, etc.)
            subtype = message.subtype
            data = message.data
            session_id = data.get("session_id") if data else None
            if session_id:
                self.output.session_id = session_id
                self._log(f"[SDK] Session: {session_id}")
            self.output.add_message(
                Message(
                    type="system",
                    subtype=subtype,
                    session_id=session_id,
                    timestamp=now,
                    raw=self._to_dict(message),
                )
            )

        elif isinstance(message, AssistantMessage):
            # Assistant messages may contain content and/or tool_use
            content = self._get_content(message)
            tool_use = self._get_tool_use(message)

            # Note: Content is already streamed via StreamEvent, so we just
            # add a newline to end the streamed block
            if content and self._log_file:
                self._log_file.write("\n")
                self._log_file.flush()

            self.output.add_message(
                Message(
                    type="assistant",
                    content=content,
                    tool_use=tool_use,
                    timestamp=now,
                    raw=self._to_dict(message),
                )
            )

            # Track tool call start and log it
            if tool_use:
                tool_name = tool_use.get("name", "unknown")
                tool_input = tool_use.get("input", {})
                tool_id = tool_use.get("id", "")

                # Log tool invocation
                if tool_name == "Bash":
                    cmd = tool_input.get("command", "")
                    self._log(f"[TOOL] Bash: {cmd[:200]}{'...' if len(cmd) > 200 else ''}")
                elif tool_name in ("Write", "Edit"):
                    file_path = tool_input.get("file_path", "")
                    self._log(f"[TOOL] {tool_name}: {file_path}")
                elif tool_name == "Read":
                    file_path = tool_input.get("file_path", "")
                    self._log(f"[TOOL] Read: {file_path}")
                elif tool_name in ("Glob", "Grep"):
                    pattern = tool_input.get("pattern", "")
                    self._log(f"[TOOL] {tool_name}: {pattern}")
                else:
                    self._log(f"[TOOL] {tool_name}")

                if tool_id:
                    self._tool_start_times[tool_id] = time.time()
                    self._pending_tool_calls[tool_id] = ToolCall(
                        name=tool_name,
                        input=tool_input,
                        tool_use_id=tool_id,
                        timestamp=now,
                    )

        elif isinstance(message, UserMessage):
            # User messages contain tool results
            content_blocks = message.content
            tool_use_id = None
            content = None
            is_error = False

            # Check if this is a tool result (has ToolResultBlock)
            if isinstance(content_blocks, list):
                for block in content_blocks:
                    if isinstance(block, ToolResultBlock):
                        tool_use_id = block.tool_use_id
                        content = block.content if isinstance(block.content, str) else str(block.content) if block.content else None
                        is_error = block.is_error or False
                        break

            if tool_use_id:
                # This is a tool result
                # Log errors from tool results
                if is_error and content:
                    self._log(f"[TOOL ERROR] {content[:500]}")

                self.output.add_message(
                    Message(
                        type="tool_result",
                        tool_use_id=tool_use_id,
                        content=content[:2000] if content and len(content) > 2000 else content,
                        timestamp=now,
                        raw=self._to_dict(message),
                    )
                )

                # Record completed tool call
                if tool_use_id in self._pending_tool_calls:
                    tool_call = self._pending_tool_calls.pop(tool_use_id)
                    start_time = self._tool_start_times.pop(tool_use_id, None)
                    if start_time:
                        tool_call.duration_ms = int((time.time() - start_time) * 1000)
                        self._log(f"[TOOL] Completed {tool_call.name} ({tool_call.duration_ms}ms)")
                    tool_call.is_error = is_error
                    self.output.add_tool_call(tool_call)
                    # Save output after each tool call for real-time viewer updates
                    self._save_output_incremental()
            else:
                # Regular user message
                content = self._get_content(message)
                self.output.add_message(
                    Message(
                        type="user",
                        content=content,
                        timestamp=now,
                        raw=self._to_dict(message),
                    )
                )

        elif isinstance(message, ResultMessage):
            # Final result message - extract token usage and cost
            if message.usage:
                self.output.input_tokens = message.usage.get("input_tokens", 0)
                self.output.output_tokens = message.usage.get("output_tokens", 0)
                self.output.cache_creation_tokens = message.usage.get(
                    "cache_creation_input_tokens", 0
                )
                self.output.cache_read_tokens = message.usage.get(
                    "cache_read_input_tokens", 0
                )

            if message.total_cost_usd is not None:
                self.output.total_cost_usd = message.total_cost_usd

            # Log usage summary after setting all fields
            if message.usage:
                self._log_usage_summary()

            subtype = message.subtype
            result = message.result
            self._log("")
            self._log(f"--- Result ({subtype}) ---")
            if result:
                for line in str(result).split("\n"):
                    self._log(line)
            self.output.add_message(
                Message(
                    type="result",
                    subtype=subtype,
                    content=result,
                    timestamp=now,
                    raw=self._to_dict(message),
                )
            )

        elif isinstance(message, StreamEvent):
            # StreamEvent - handle streaming deltas
            event = message.event
            event_type = event.get("type", "") if isinstance(event, dict) else ""

            if event_type == "content_block_delta":
                delta = event.get("delta", {})
                if delta.get("type") == "text_delta":
                    text = delta.get("text", "")
                    if text:
                        # Stream text without newline for partial chunks
                        if self._log_file:
                            self._log_file.write(text)
                            self._log_file.flush()

            # Don't store every stream event in output (too verbose)
            # Only store significant events

        else:
            # Unknown message type - still record it
            self.output.add_message(
                Message(
                    type="unknown",
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
                if isinstance(block, TextBlock):
                    text_parts.append(block.text)
                elif isinstance(block, dict):
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
                if isinstance(block, ToolUseBlock):
                    return {
                        "name": block.name,
                        "input": block.input,
                        "id": block.id,
                    }
                elif isinstance(block, dict) and block.get("type") == "tool_use":
                    return {
                        "name": block.get("name"),
                        "input": block.get("input", {}),
                        "id": block.get("id"),
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
        "--allowed-tools",
        help="Comma-separated list of allowed tools",
    )
    parser.add_argument(
        "--max-buffer-size",
        type=int,
        help="Maximum size (bytes) for a single streamed JSON message from the CLI",
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
        max_buffer_size=args.max_buffer_size,
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
