import type { ComponentType } from 'react';
import { BashTool } from './BashTool.js';
import { ReadTool } from './ReadTool.js';
import { WriteTool } from './WriteTool.js';
import { GlobTool } from './GlobTool.js';
import { GrepTool } from './GrepTool.js';
import { EditTool } from './EditTool.js';
import { TaskTool } from './TaskTool.js';
import { GenericTool } from './GenericTool.js';

type ToolRendererProps = {
  input: Record<string, unknown>;
};

type GenericRendererProps = {
  name: string;
  input: Record<string, unknown>;
};

// Registry mapping tool names to their specific renderers
// Includes both Claude Code tool names and SDK event names
const toolRegistry: Record<string, ComponentType<ToolRendererProps>> = {
  // Claude Code names
  Bash: BashTool,
  Read: ReadTool,
  Write: WriteTool,
  Glob: GlobTool,
  Grep: GrepTool,
  Edit: EditTool,
  Task: TaskTool,
  // SDK event names (snake_case variants)
  command_execution: BashTool,
  file_read: ReadTool,
  file_write: WriteTool,
  glob: GlobTool,
  grep: GrepTool,
  file_edit: EditTool,
  task: TaskTool,
  // Additional common aliases
  bash: BashTool,
  read: ReadTool,
  write: WriteTool,
  edit: EditTool,
};

export function getToolRenderer(toolName: string): ComponentType<ToolRendererProps> | null {
  // Try exact match first, then lowercase
  return toolRegistry[toolName] || toolRegistry[toolName.toLowerCase()] || null;
}

export { GenericTool };
export type { ToolRendererProps, GenericRendererProps };
