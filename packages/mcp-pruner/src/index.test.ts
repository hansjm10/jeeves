import { spawn } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers – spawn the MCP server and exchange JSON-RPC messages over stdio
// ---------------------------------------------------------------------------

const SERVER_ENTRY = path.resolve(
  import.meta.dirname ?? __dirname,
  "../dist/index.js",
);

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Send one or more JSON-RPC requests to the MCP server and collect the
 * responses. The server is spawned as a child process and killed after
 * all expected responses have been received (or after a timeout).
 */
function sendRequests(
  requests: object[],
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<JsonRpcResponse[]> {
  return new Promise<JsonRpcResponse[]>((resolve, reject) => {
    const child = spawn("node", [SERVER_ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MCP_PRUNER_CWD: process.cwd() },
    });

    const responses: JsonRpcResponse[] = [];
    let buffer = "";
    const expectedCount = requests.length;

    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `Timed out waiting for ${expectedCount} responses (got ${responses.length})`,
        ),
      );
    }, timeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      // JSON-RPC messages are newline-delimited
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) {
          try {
            responses.push(JSON.parse(line));
          } catch {
            // ignore non-JSON lines
          }
        }
        if (responses.length >= expectedCount) {
          clearTimeout(timer);
          child.kill();
          resolve(responses);
          return;
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("exit", () => {
      clearTimeout(timer);
      resolve(responses);
    });

    // Write all requests
    for (const req of requests) {
      child.stdin!.write(JSON.stringify(req) + "\n");
    }
    child.stdin!.end();
  });
}

/**
 * Convenience: send a single request and return the single response.
 */
async function sendRequest(request: object): Promise<JsonRpcResponse> {
  const [response] = await sendRequests([request]);
  return response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mcp-pruner server", () => {
  // -------------------------------------------------------------------------
  // Initialize compatibility
  // -------------------------------------------------------------------------
  describe("initialize compatibility", () => {
    it("accepts capabilities-only params (no protocolVersion / clientInfo)", async () => {
      const response = await sendRequest({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: { capabilities: {} },
      });

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      expect(response.result!.serverInfo).toEqual({
        name: "mcp-pruner",
        version: "1.0.0",
      });
    });

    it("accepts full initialize params with protocolVersion and clientInfo", async () => {
      const response = await sendRequest({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      });

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      expect(response.result!.serverInfo).toEqual({
        name: "mcp-pruner",
        version: "1.0.0",
      });
    });

    it("accepts initialize with empty params", async () => {
      const response = await sendRequest({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {},
      });

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      expect(response.result!.serverInfo).toEqual({
        name: "mcp-pruner",
        version: "1.0.0",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Invalid params – initialize
  // -------------------------------------------------------------------------
  describe("initialize invalid params", () => {
    it("returns -32602 with exact message for invalid protocolVersion type", async () => {
      const response = await sendRequest({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: { protocolVersion: 123, capabilities: {} },
      });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
      expect(response.error!.message).toBe("Invalid params");
    });

    it("returns -32602 with exact message for invalid clientInfo type", async () => {
      const response = await sendRequest({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: "not-an-object",
        },
      });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
      expect(response.error!.message).toBe("Invalid params");
    });
  });

  // -------------------------------------------------------------------------
  // Invalid params – tools/call
  // -------------------------------------------------------------------------
  describe("tools/call invalid params", () => {
    it("returns -32602 for read missing file_path", async () => {
      const responses = await sendRequests([
        {
          jsonrpc: "2.0",
          method: "initialize",
          id: 1,
          params: { capabilities: {} },
        },
        {
          jsonrpc: "2.0",
          method: "tools/call",
          id: 2,
          params: { name: "read", arguments: {} },
        },
      ]);

      const toolResponse = responses.find((r) => r.id === 2);
      expect(toolResponse).toBeDefined();
      expect(toolResponse!.error).toBeDefined();
      expect(toolResponse!.error!.code).toBe(-32602);
      expect(toolResponse!.error!.message).toBe("Invalid params");
    });

    it("returns -32602 for bash missing command", async () => {
      const responses = await sendRequests([
        {
          jsonrpc: "2.0",
          method: "initialize",
          id: 1,
          params: { capabilities: {} },
        },
        {
          jsonrpc: "2.0",
          method: "tools/call",
          id: 2,
          params: { name: "bash", arguments: {} },
        },
      ]);

      const toolResponse = responses.find((r) => r.id === 2);
      expect(toolResponse).toBeDefined();
      expect(toolResponse!.error).toBeDefined();
      expect(toolResponse!.error!.code).toBe(-32602);
      expect(toolResponse!.error!.message).toBe("Invalid params");
    });

    it("returns -32602 for grep missing pattern", async () => {
      const responses = await sendRequests([
        {
          jsonrpc: "2.0",
          method: "initialize",
          id: 1,
          params: { capabilities: {} },
        },
        {
          jsonrpc: "2.0",
          method: "tools/call",
          id: 2,
          params: { name: "grep", arguments: {} },
        },
      ]);

      const toolResponse = responses.find((r) => r.id === 2);
      expect(toolResponse).toBeDefined();
      expect(toolResponse!.error).toBeDefined();
      expect(toolResponse!.error!.code).toBe(-32602);
      expect(toolResponse!.error!.message).toBe("Invalid params");
    });
  });
});
