<tooling_guidance>
- When searching across file contents to find where something is implemented, prefer MCP pruner search tools first (for example `mcp:pruner/grep` with `context_focus_question`).
- When you already know the exact file/path to inspect, use the MCP pruner `read` tool.
- Shell-based file search/read commands are still allowed when needed, but MCP pruner tools are the default for file discovery and file reading.
</tooling_guidance>

# Runner fixture prompt

You are running a minimal Jeeves fixture workflow.

Output `<promise>COMPLETE</promise>` when done.
