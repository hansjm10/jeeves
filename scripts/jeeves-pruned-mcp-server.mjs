#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFloat(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function resolveRoot() {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--root");
  const root = idx >= 0 ? args[idx + 1] : null;
  return path.resolve(root ?? process.cwd());
}

function ensureUnderRoot(rootAbs, requestedPath) {
  const resolved = path.resolve(rootAbs, requestedPath);
  if (resolved === rootAbs) return resolved;
  if (resolved.startsWith(`${rootAbs}${path.sep}`)) return resolved;
  throw new Error(`path outside root: ${requestedPath}`);
}

async function prune({ prunerUrl, timeoutMs, query, code, threshold }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(prunerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query,
        code,
        ...(threshold !== undefined ? { threshold } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object") return null;
    const pruned = json.pruned_code;
    if (typeof pruned === "string" && pruned.trim()) return pruned;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const rootAbs = resolveRoot();

  const prunerUrl = process.env.JEEVES_PRUNER_URL ?? "http://localhost:8000/prune";
  const timeoutMs = envInt("JEEVES_PRUNER_TIMEOUT_MS", 30_000);
  const defaultThreshold = envFloat("JEEVES_PRUNER_THRESHOLD");

  const server = new McpServer({ name: "jeeves-pruned", version: "1.0.0" });

  server.registerTool(
    "Read",
    {
      description:
        "Read a file (optionally pruned). If context_focus_question is provided, calls the pruner service and returns pruned content; otherwise returns full content.",
      inputSchema: {
        path: z.string().describe("Path to read (relative to --root or absolute under it)"),
        context_focus_question: z.string().nullable().optional(),
        threshold: z.number().min(0).max(1).optional(),
      },
    },
    async ({ path: requestedPath, context_focus_question, threshold }) => {
      try {
        const fileAbs = ensureUnderRoot(rootAbs, requestedPath);
        const content = await fs.readFile(fileAbs, "utf-8");

        const query = (context_focus_question ?? "").trim();
        if (!query) return { content: [{ type: "text", text: content }] };

        const pruned = await prune({
          prunerUrl,
          timeoutMs,
          query,
          code: content,
          threshold: threshold ?? (defaultThreshold ?? undefined),
        });
        return { content: [{ type: "text", text: pruned ?? content }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `Read failed: ${msg}` }] };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

