import fs from "node:fs/promises";
import path from "node:path";

import { runProcess } from "./processRunner";

const MAX_DYNAMIC_TOOL_RESULTS = 200;
const DEFAULT_DYNAMIC_TOOL_RESULTS = 20;
const DEFAULT_READ_FILE_BYTES = 256 * 1024;
const MAX_READ_FILE_BYTES = 512 * 1024;
const DEFAULT_AROUND_LINE_COUNT = 40;

interface DynamicToolTextContent {
  readonly type: "input_text";
  readonly text: string;
}

type JsonSchema = Record<string, unknown>;

export interface CodexDynamicToolResult {
  readonly content: ReadonlyArray<DynamicToolTextContent>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

export interface CodexDynamicToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

interface CodexDynamicToolDefinition extends CodexDynamicToolSpec {
  readonly instructionExample: string;
}

interface SearchWorkspaceArgs {
  readonly query: string;
  readonly mode: "path" | "content";
  readonly glob?: string;
  readonly caseSensitive?: boolean;
  readonly maxResults?: number;
}

interface ReadFileRequest {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly aroundLine?: number;
  readonly lineCount?: number;
  readonly maxBytes?: number;
}

interface ReadFilesArgs {
  readonly requests: ReadonlyArray<ReadFileRequest>;
}

interface WorkspacePath {
  readonly absolutePath: string;
  readonly displayPath: string;
}

const DYNAMIC_TOOL_DEFINITIONS: ReadonlyArray<CodexDynamicToolDefinition> = [
  {
    name: "search_workspace",
    description: "Fast workspace search by path or content.",
    instructionExample:
      '{"query": string, "mode": "path" | "content", "glob"?: string, "caseSensitive"?: boolean, "maxResults"?: number}',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        mode: { type: "string", enum: ["path", "content"] },
        glob: { type: "string" },
        caseSensitive: { type: "boolean" },
        maxResults: { type: "integer", minimum: 1 },
      },
      required: ["query", "mode"],
      additionalProperties: false,
    },
  },
  {
    name: "read_files",
    description: "Batch-read UTF-8 text files. Prefer batching related files in one call.",
    instructionExample:
      '{"requests":[{"path": string, "startLine"?: number, "endLine"?: number, "aroundLine"?: number, "lineCount"?: number, "maxBytes"?: number}, ...]}',
    inputSchema: {
      type: "object",
      properties: {
        requests: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              startLine: { type: "integer", minimum: 1 },
              endLine: { type: "integer", minimum: 1 },
              aroundLine: { type: "integer", minimum: 1 },
              lineCount: { type: "integer", minimum: 1 },
              maxBytes: { type: "integer", minimum: 1 },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
      required: ["requests"],
      additionalProperties: false,
    },
  },
];

function buildDynamicToolInstructions(): string {
  const lines = [
    "## Dynamic Tools",
    "",
    "Use these custom tools directly for repository investigation instead of shelling out.",
    "",
  ];

  for (const tool of DYNAMIC_TOOL_DEFINITIONS) {
    lines.push(`### ${tool.name}`);
    lines.push(`Input JSON: ${tool.instructionExample}`);
    lines.push(tool.description);
    lines.push("");
  }

  return lines.slice(0, -1).join("\n");
}

export const CODEX_DYNAMIC_TOOL_DEVELOPER_INSTRUCTIONS = buildDynamicToolInstructions();

export function buildCodexDynamicToolSpecs(): ReadonlyArray<CodexDynamicToolSpec> {
  return DYNAMIC_TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function clampCount(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.max(1, Math.min(value, max));
}

function clampMaxResults(value: number | undefined): number {
  return clampCount(value, DEFAULT_DYNAMIC_TOOL_RESULTS, MAX_DYNAMIC_TOOL_RESULTS);
}

function clampReadBytes(value: number | undefined): number {
  return clampCount(value, DEFAULT_READ_FILE_BYTES, MAX_READ_FILE_BYTES);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function normalizeDisplayPath(value: string): string {
  let normalized = value;
  while (normalized.startsWith("././")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function formatToolTextResult(
  text: string,
  structuredContent?: Record<string, unknown>,
): CodexDynamicToolResult {
  return {
    content: [{ type: "input_text", text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function formatToolErrorResult(
  text: string,
  structuredContent?: Record<string, unknown>,
): CodexDynamicToolResult {
  return {
    content: [{ type: "input_text", text }],
    isError: true,
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function parseSearchWorkspaceArgs(value: unknown): SearchWorkspaceArgs | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const query = asString(record.query);
  const mode = asString(record.mode);
  if (!query || (mode !== "path" && mode !== "content")) {
    return undefined;
  }

  const glob = asString(record.glob);
  const caseSensitive = asBoolean(record.caseSensitive);
  const maxResults = asSafeInteger(record.maxResults);

  return {
    query,
    mode,
    ...(glob ? { glob } : {}),
    ...(caseSensitive !== undefined ? { caseSensitive } : {}),
    ...(maxResults !== undefined ? { maxResults } : {}),
  };
}

function parseReadFileRequest(value: unknown): ReadFileRequest | undefined {
  const record = asRecord(value);
  const filePath = asString(record?.path);
  if (!record || !filePath) {
    return undefined;
  }

  const startLine = asSafeInteger(record.startLine);
  const endLine = asSafeInteger(record.endLine);
  const aroundLine = asSafeInteger(record.aroundLine);
  const lineCount = asSafeInteger(record.lineCount);
  const maxBytes = asSafeInteger(record.maxBytes);

  return {
    path: filePath,
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
    ...(aroundLine !== undefined ? { aroundLine } : {}),
    ...(lineCount !== undefined ? { lineCount } : {}),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  };
}

function parseReadFilesArgs(value: unknown): ReadFilesArgs | undefined {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.requests) || record.requests.length === 0) {
    return undefined;
  }

  const requests = record.requests.map(parseReadFileRequest);
  if (requests.some((request) => request === undefined)) {
    return undefined;
  }

  return {
    requests: requests as ReadonlyArray<ReadFileRequest>,
  };
}

function resolveWorkspacePath(cwd: string, requestedPath: string): WorkspacePath {
  const absolutePath = path.resolve(cwd, requestedPath);
  const relativePath = path.relative(cwd, absolutePath);
  if (
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath) ||
    relativePath.length === 0
  ) {
    throw new Error(`Path must stay within the workspace: ${requestedPath}`);
  }

  return {
    absolutePath,
    displayPath: normalizeDisplayPath(toPosixPath(relativePath)),
  };
}

async function searchWorkspacePaths(
  args: SearchWorkspaceArgs,
  cwd: string,
): Promise<CodexDynamicToolResult> {
  const rgArgs = ["--files"];
  if (args.glob) {
    rgArgs.push("-g", args.glob);
  }

  const result = await runProcess("rg", rgArgs, {
    cwd,
    allowNonZeroExit: true,
  });
  const query = args.caseSensitive ? args.query : args.query.toLowerCase();
  const matchingPaths = result.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => {
      const candidate = args.caseSensitive ? entry : entry.toLowerCase();
      return candidate.includes(query);
    })
    .slice(0, clampMaxResults(args.maxResults))
    .map((entry) => normalizeDisplayPath(toPosixPath(entry)));

  if (matchingPaths.length === 0) {
    return formatToolTextResult("No path matches found.", { paths: [] });
  }

  return formatToolTextResult(matchingPaths.join("\n"), { paths: matchingPaths });
}

async function searchWorkspaceContent(
  args: SearchWorkspaceArgs,
  cwd: string,
): Promise<CodexDynamicToolResult> {
  const rgArgs = ["--color", "never", "--line-number", "--no-heading"];
  if (!args.caseSensitive) {
    rgArgs.push("-i");
  }
  if (args.glob) {
    rgArgs.push("-g", args.glob);
  }
  rgArgs.push(args.query, ".");

  const result = await runProcess("rg", rgArgs, {
    cwd,
    allowNonZeroExit: true,
    maxBufferBytes: 2 * 1024 * 1024,
    outputMode: "truncate",
  });

  const matches = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, clampMaxResults(args.maxResults))
    .map((line) => {
      const match = /^(.*?):(\d+):(.*)$/u.exec(line);
      if (!match) {
        return undefined;
      }

      const matchedPath = match[1];
      const matchedLine = match[2];
      if (!matchedPath || !matchedLine) {
        return undefined;
      }

      return {
        path: normalizeDisplayPath(toPosixPath(matchedPath)),
        line: Number.parseInt(matchedLine, 10),
        preview: match[3] ?? "",
      };
    })
    .filter((match): match is { path: string; line: number; preview: string } => match !== undefined);

  if (matches.length === 0) {
    return formatToolTextResult("No content matches found.", { matches: [] });
  }

  const text = matches.map((match) => `${match.path}:${match.line}: ${match.preview}`).join("\n");
  return formatToolTextResult(text, { matches });
}

function computeReadWindow(totalLines: number, request: ReadFileRequest): { start: number; end: number } {
  if (totalLines === 0) {
    return { start: 1, end: 0 };
  }

  if (request.aroundLine !== undefined) {
    const count = request.lineCount ?? DEFAULT_AROUND_LINE_COUNT;
    const clampedCount = Math.max(1, count);
    const center = Math.max(1, Math.min(request.aroundLine, totalLines));
    let start = Math.max(1, center - Math.floor((clampedCount - 1) / 2));
    let end = Math.min(totalLines, start + clampedCount - 1);
    start = Math.max(1, end - clampedCount + 1);
    return { start, end };
  }

  const start = Math.max(1, Math.min(request.startLine ?? 1, totalLines));
  const requestedEnd =
    request.endLine ?? (request.lineCount !== undefined ? start + request.lineCount - 1 : totalLines);
  const end = Math.max(start, Math.min(requestedEnd, totalLines));
  return { start, end };
}

function renderReadSection(lines: ReadonlyArray<string>, start: number): string {
  return lines
    .map((line, index) => `${String(start + index).padStart(4, " ")} | ${line}`)
    .join("\n");
}

async function readWorkspaceFiles(args: ReadFilesArgs, cwd: string): Promise<CodexDynamicToolResult> {
  const sections: string[] = [];
  const files: Array<Record<string, unknown>> = [];

  for (const request of args.requests) {
    try {
      const workspacePath = resolveWorkspacePath(cwd, request.path);
      const maxBytes = clampReadBytes(request.maxBytes);
      const buffer = await fs.readFile(workspacePath.absolutePath);
      const binary = buffer.includes(0);
      const truncated = buffer.length > maxBytes;
      const visibleBuffer = truncated ? buffer.subarray(0, maxBytes) : buffer;

      if (binary) {
        sections.push(`FILE ${workspacePath.displayPath}\nBINARY true\nSIZE_BYTES ${buffer.length}`);
        files.push({
          path: workspacePath.displayPath,
          binary: true,
          sizeBytes: buffer.length,
        });
        continue;
      }

      const text = visibleBuffer.toString("utf8");
      const allLines = text.split(/\r?\n/u);
      const totalLines = allLines.length;
      const window = computeReadWindow(totalLines, request);
      const selectedLines =
        window.end >= window.start ? allLines.slice(window.start - 1, window.end) : [];

      sections.push(
        [
          `FILE ${workspacePath.displayPath}`,
          `LINES ${window.start}-${window.end}`,
          `TOTAL_LINES ${totalLines}`,
          `TRUNCATED ${truncated}`,
          renderReadSection(selectedLines, window.start),
        ]
          .filter((entry) => entry.length > 0)
          .join("\n"),
      );

      files.push({
        path: workspacePath.displayPath,
        binary: false,
        sizeBytes: buffer.length,
        totalLines,
        truncated,
        startLine: window.start,
        endLine: window.end,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sections.push(`FILE ${request.path}\nERROR ${message}`);
      files.push({
        path: request.path,
        error: message,
      });
    }
  }

  return formatToolTextResult(sections.join("\n\n"), { files });
}

export async function executeCodexDynamicTool(input: {
  readonly cwd: string;
  readonly tool: string;
  readonly arguments: unknown;
}): Promise<CodexDynamicToolResult> {
  if (input.tool === "search_workspace") {
    const args = parseSearchWorkspaceArgs(input.arguments);
    if (!args) {
      return formatToolErrorResult(
        "search_workspace arguments must include query, mode, and optional glob/caseSensitive/maxResults fields.",
      );
    }
    return args.mode === "path"
      ? searchWorkspacePaths(args, input.cwd)
      : searchWorkspaceContent(args, input.cwd);
  }

  if (input.tool === "read_files") {
    const args = parseReadFilesArgs(input.arguments);
    if (!args) {
      return formatToolErrorResult(
        "read_files arguments must be an object with a non-empty requests array.",
      );
    }
    return readWorkspaceFiles(args, input.cwd);
  }

  return formatToolErrorResult(`Unsupported dynamic tool: ${input.tool}`);
}
