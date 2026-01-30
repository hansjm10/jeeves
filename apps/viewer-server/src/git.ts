import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GitResult = Readonly<{ stdout: string; stderr: string }>;

export async function runGit(args: string[], options?: { cwd?: string }): Promise<GitResult> {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd: options?.cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
}

