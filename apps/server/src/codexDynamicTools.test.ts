import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildCodexDynamicToolSpecs, executeCodexDynamicTool } from "./codexDynamicTools";

describe("executeCodexDynamicTool", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(os.tmpdir(), "t3-codex-dynamic-tools-"));
    mkdirSync(path.join(cwd, "src", "auth"), { recursive: true });
    writeFileSync(path.join(cwd, "README.md"), "# Hello\n", "utf8");
    writeFileSync(
      path.join(cwd, "src", "auth", "auth.ts"),
      [
        "export interface Session {",
        "  token: string;",
        "}",
        "",
        "export function validateToken() {",
        '  return "ok";',
        "}",
        "",
        "const internalHelper = () => true;",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(cwd, "src", "auth", "guard.ts"),
      [
        'import { validateToken } from "./auth";',
        "",
        "export function requireAuth() {",
        "  return validateToken();",
        "}",
      ].join("\n"),
      "utf8",
    );
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("searches workspace paths without shell-style file inspection", async () => {
    const result = await executeCodexDynamicTool({
      cwd,
      tool: "search_workspace",
      arguments: {
        query: "auth",
        mode: "path",
      },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('PATH SEARCH "auth"');
    expect(result.content[0]?.text).toContain("./src/auth/auth.ts");
  });

  it("searches workspace content and returns matching line previews", async () => {
    const result = await executeCodexDynamicTool({
      cwd,
      tool: "search_workspace",
      arguments: {
        query: "validateToken",
        mode: "content",
      },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('CONTENT SEARCH "validateToken"');
    expect(result.content[0]?.text).toContain("./src/auth/auth.ts:5: export function validateToken()");
  });

  it("reads multiple files in a single call with aroundLine windows", async () => {
    const result = await executeCodexDynamicTool({
      cwd,
      tool: "read_files",
      arguments: {
        requests: [
          { path: "README.md" },
          { path: "src/auth/auth.ts", aroundLine: 5, lineCount: 3 },
        ],
      },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("FILE README.md");
    expect(result.content[0]?.text).toContain("FILE src/auth/auth.ts");
    expect(result.content[0]?.text).toContain("TOTAL_LINES 9");
    expect(result.content[0]?.text).toContain('5 | export function validateToken() {');
  });

  it("finds top-level symbols in a file", async () => {
    const result = await executeCodexDynamicTool({
      cwd,
      tool: "find_symbols",
      arguments: {
        paths: ["src/auth/auth.ts"],
      },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("SYMBOLS");
    expect(result.content[0]?.text).toContain("- interface Session @ 1 exported");
    expect(result.content[0]?.text).toContain("- function validateToken @ 5 exported");
    expect(result.content[0]?.text).toContain("- const internalHelper @ 9");
  });

  it("finds exported api in a file", async () => {
    const result = await executeCodexDynamicTool({
      cwd,
      tool: "find_exported_api",
      arguments: {
        paths: ["src/auth/auth.ts"],
      },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("EXPORTED API");
    expect(result.content[0]?.text).toContain("- interface Session @ 1 exported");
    expect(result.content[0]?.text).toContain("- function validateToken @ 5 exported");
    expect(result.content[0]?.text).not.toContain("internalHelper");
  });

  it("finds references across the workspace", async () => {
    const result = await executeCodexDynamicTool({
      cwd,
      tool: "find_references",
      arguments: {
        query: "validateToken",
        exactWord: true,
      },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('REFERENCES "validateToken"');
    expect(result.content[0]?.text).toContain("./src/auth/guard.ts:1: import { validateToken } from \"./auth\";");
    expect(result.content[0]?.text).toContain("./src/auth/guard.ts:4:   return validateToken();");
  });

  it("finds text with surrounding context", async () => {
    const result = await executeCodexDynamicTool({
      cwd,
      tool: "find_text_with_context",
      arguments: {
        query: "return validateToken",
        contextLines: 1,
      },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('TEXT WITH CONTEXT "return validateToken"');
    expect(result.content[0]?.text).toContain("MATCH ./src/auth/guard.ts:3-5");
    expect(result.content[0]?.text).toContain("4 |   return validateToken();");
  });

  it("lists directories relative to the workspace root", async () => {
    const result = await executeCodexDynamicTool({
      cwd,
      tool: "list_directory",
      arguments: {
        path: "src",
        maxDepth: 2,
      },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('DIRECTORY LIST "src"');
    expect(result.content[0]?.text).toContain("- [directory] ./src/auth");
    expect(result.content[0]?.text).toContain("- [file] ./src/auth/auth.ts");
  });

  it("returns metadata for files", async () => {
    const result = await executeCodexDynamicTool({
      cwd,
      tool: "stat_files",
      arguments: {
        paths: ["src/auth/auth.ts", "src/auth"],
      },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("FILE STATS");
    expect(result.content[0]?.text).toContain("PATH src/auth/auth.ts");
    expect(result.content[0]?.text).toContain("TYPE file");
    expect(result.content[0]?.text).toContain("LINE_COUNT 9");
    expect(result.content[0]?.text).toContain("PATH src/auth");
    expect(result.content[0]?.text).toContain("TYPE directory");
  });

  it("rejects unsupported dynamic tools", async () => {
    const result = await executeCodexDynamicTool({
      cwd,
      tool: "unsupported_tool",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unsupported dynamic tool");
  });
});

describe("buildCodexDynamicToolSpecs", () => {
  it("returns structured specs for every repo investigation tool", () => {
    expect(buildCodexDynamicToolSpecs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "search_workspace",
          description: expect.stringContaining("search"),
          inputSchema: expect.objectContaining({
            type: "object",
          }),
        }),
        expect.objectContaining({
          name: "read_files",
          inputSchema: expect.objectContaining({
            type: "object",
          }),
        }),
        expect.objectContaining({
          name: "find_symbols",
        }),
        expect.objectContaining({
          name: "find_exported_api",
        }),
        expect.objectContaining({
          name: "find_references",
        }),
        expect.objectContaining({
          name: "find_text_with_context",
        }),
        expect.objectContaining({
          name: "list_directory",
        }),
        expect.objectContaining({
          name: "stat_files",
        }),
      ]),
    );
  });
});
