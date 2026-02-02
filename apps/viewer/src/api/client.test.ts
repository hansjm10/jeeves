import { describe, expect, it, vi, afterEach } from "vitest";

import type { ExpandIssueRequest } from "./types.js";
import { buildExpandIssueRequestBody, getWorkflowDefaults } from "./client.js";

/**
 * Tests for client.ts expand issue request body formation.
 *
 * These tests verify that buildExpandIssueRequestBody correctly forms the request body:
 * - Always includes summary
 * - Conditionally includes issue_type when provided
 * - Conditionally includes provider when provided
 * - Conditionally includes model when provided
 * - Omits optional fields when undefined
 */

describe("buildExpandIssueRequestBody", () => {
  describe("summary field (required)", () => {
    it("always includes summary", () => {
      const input: ExpandIssueRequest = { summary: "Add a new feature" };
      const body = buildExpandIssueRequestBody(input);

      expect(body.summary).toBe("Add a new feature");
    });

    it("preserves whitespace in summary", () => {
      const input: ExpandIssueRequest = { summary: "  spaced summary  " };
      const body = buildExpandIssueRequestBody(input);

      expect(body.summary).toBe("  spaced summary  ");
    });
  });

  describe("issue_type field (optional)", () => {
    it("includes issue_type when provided", () => {
      const input: ExpandIssueRequest = {
        summary: "Fix a bug",
        issue_type: "bug",
      };
      const body = buildExpandIssueRequestBody(input);

      expect(body.issue_type).toBe("bug");
    });

    it("omits issue_type when undefined", () => {
      const input: ExpandIssueRequest = { summary: "Add feature" };
      const body = buildExpandIssueRequestBody(input);

      expect("issue_type" in body).toBe(false);
    });

    it("handles all valid issue types", () => {
      const types = ["feature", "bug", "refactor"] as const;

      for (const type of types) {
        const input: ExpandIssueRequest = { summary: "Test", issue_type: type };
        const body = buildExpandIssueRequestBody(input);
        expect(body.issue_type).toBe(type);
      }
    });
  });

  describe("provider field (optional)", () => {
    it("includes provider when provided", () => {
      const input: ExpandIssueRequest = { summary: "Test", provider: "codex" };
      const body = buildExpandIssueRequestBody(input);

      expect(body.provider).toBe("codex");
    });

    it("omits provider when undefined", () => {
      const input: ExpandIssueRequest = { summary: "Test" };
      const body = buildExpandIssueRequestBody(input);

      expect("provider" in body).toBe(false);
    });
  });

  describe("model field (optional)", () => {
    it("includes model when provided", () => {
      const input: ExpandIssueRequest = { summary: "Test", model: "gpt-4" };
      const body = buildExpandIssueRequestBody(input);

      expect(body.model).toBe("gpt-4");
    });

    it("omits model when undefined", () => {
      const input: ExpandIssueRequest = { summary: "Test" };
      const body = buildExpandIssueRequestBody(input);

      expect("model" in body).toBe(false);
    });
  });

  describe("combined fields", () => {
    it("includes all fields when all provided", () => {
      const input: ExpandIssueRequest = {
        summary: "Implement dark mode",
        issue_type: "feature",
        provider: "claude",
        model: "claude-3-opus",
      };
      const body = buildExpandIssueRequestBody(input);

      expect(body).toEqual({
        summary: "Implement dark mode",
        issue_type: "feature",
        provider: "claude",
        model: "claude-3-opus",
      });
    });

    it("includes only summary and issue_type when others omitted", () => {
      const input: ExpandIssueRequest = {
        summary: "Refactor auth module",
        issue_type: "refactor",
      };
      const body = buildExpandIssueRequestBody(input);

      expect(body).toEqual({
        summary: "Refactor auth module",
        issue_type: "refactor",
      });
      expect(Object.keys(body)).toHaveLength(2);
    });
  });

  describe("JSON serialization", () => {
    it("serializes body with only summary correctly", () => {
      const input: ExpandIssueRequest = { summary: "Test summary" };
      const body = buildExpandIssueRequestBody(input);
      const json = JSON.stringify(body);

      expect(json).toBe('{"summary":"Test summary"}');
    });

    it("serializes body with all fields correctly", () => {
      const input: ExpandIssueRequest = {
        summary: "Test",
        issue_type: "feature",
        provider: "claude",
        model: "opus",
      };
      const body = buildExpandIssueRequestBody(input);
      const json = JSON.stringify(body);

      expect(json).toContain('"summary":"Test"');
      expect(json).toContain('"issue_type":"feature"');
      expect(json).toContain('"provider":"claude"');
      expect(json).toContain('"model":"opus"');
    });
  });
});

/**
 * Tests for getWorkflowDefaults - fetches provider/model defaults from the default workflow.
 */
describe("getWorkflowDefaults", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("successful workflow fetch", () => {
    it("extracts provider from workflow config", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                ok: true,
                name: "default",
                yaml: "",
                workflow: { default_provider: "codex" },
              }),
            ),
        }),
      );

      const result = await getWorkflowDefaults("http://localhost:3000");

      expect(result.provider).toBe("codex");
      expect(result.model).toBeUndefined();
    });

    it("extracts both provider and model from workflow config", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                ok: true,
                name: "default",
                yaml: "",
                workflow: { default_provider: "claude", default_model: "sonnet" },
              }),
            ),
        }),
      );

      const result = await getWorkflowDefaults("http://localhost:3000");

      expect(result.provider).toBe("claude");
      expect(result.model).toBe("sonnet");
    });

    it("falls back to claude when default_provider is not set", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                ok: true,
                name: "default",
                yaml: "",
                workflow: {},
              }),
            ),
        }),
      );

      const result = await getWorkflowDefaults("http://localhost:3000");

      expect(result.provider).toBe("claude");
      expect(result.model).toBeUndefined();
    });

    it("ignores empty string provider", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                ok: true,
                name: "default",
                yaml: "",
                workflow: { default_provider: "", default_model: "" },
              }),
            ),
        }),
      );

      const result = await getWorkflowDefaults("http://localhost:3000");

      expect(result.provider).toBe("claude");
      expect(result.model).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("returns fallback defaults when fetch fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Network error")),
      );

      const result = await getWorkflowDefaults("http://localhost:3000");

      expect(result.provider).toBe("claude");
      expect(result.model).toBeUndefined();
    });

    it("returns fallback defaults when response is not ok", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          text: () => Promise.resolve(JSON.stringify({ error: "Not found" })),
        }),
      );

      const result = await getWorkflowDefaults("http://localhost:3000");

      expect(result.provider).toBe("claude");
      expect(result.model).toBeUndefined();
    });

    it("returns fallback defaults when workflow is missing", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                ok: true,
                name: "default",
                yaml: "",
                // workflow field missing
              }),
            ),
        }),
      );

      const result = await getWorkflowDefaults("http://localhost:3000");

      expect(result.provider).toBe("claude");
      expect(result.model).toBeUndefined();
    });
  });

  describe("URL construction", () => {
    it("calls the correct endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              ok: true,
              name: "default",
              yaml: "",
              workflow: { default_provider: "claude" },
            }),
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      await getWorkflowDefaults("http://localhost:3000");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledUrl = mockFetch.mock.calls[0][0] as URL;
      expect(calledUrl.toString()).toBe(
        "http://localhost:3000/api/workflows/default",
      );
    });
  });
});
