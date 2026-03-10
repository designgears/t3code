import fs from "node:fs/promises";
import path from "node:path";

import { runProcess } from "./processRunner";

const MAX_DYNAMIC_TOOL_RESULTS = 200;
const DEFAULT_DYNAMIC_TOOL_RESULTS = 20;
const DEFAULT_READ_FILE_BYTES = 256 * 1024;
const MAX_READ_FILE_BYTES = 512 * 1024;
const DEFAULT_CONTEXT_LINES = 2;
const DEFAULT_AROUND_LINE_COUNT = 40;
const MAX_DIRECTORY_DEPTH = 6;
const MAX_DIRECTORY_RESULTS = 400;
const MAX_SYMBOLS_PER_FILE = 100;

interface DynamicToolTextContent {
  type: "input_text";
  text: string;
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

type SearchMode = "path" | "content";

interface SearchWorkspaceArgs {
  readonly query: string;
  readonly mode: SearchMode;
  readonly glob?: string;
  readonly caseSensitive?: boolean;
  readonly maxResults?: number;
}

interface FindReferencesArgs {
  readonly query: string;
  readonly glob?: string;
  readonly caseSensitive?: boolean;
  readonly exactWord?: boolean;
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

interface PathsArgs {
  readonly paths: ReadonlyArray<string>;
}

interface FindSymbolsArgs extends PathsArgs {
  readonly maxResultsPerFile?: number;
}

interface FindExportedApiArgs extends PathsArgs {
  readonly maxResultsPerFile?: number;
}

interface ListDirectoryArgs {
  readonly path?: string;
  readonly maxDepth?: number;
  readonly includeFiles?: boolean;
  readonly includeDirectories?: boolean;
  readonly maxResults?: number;
}

interface StatFilesArgs extends PathsArgs {
  readonly maxBytes?: number;
}

interface FindTextWithContextArgs {
  readonly query: string;
  readonly glob?: string;
  readonly caseSensitive?: boolean;
  readonly contextLines?: number;
  readonly maxResults?: number;
}

interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly preview: string;
}

interface WorkspacePath {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly displayPath: string;
}

interface ReadTextFileResult {
  readonly contents: string;
  readonly sizeBytes: number;
  readonly truncated: boolean;
  readonly binary: boolean;
  readonly lines: ReadonlyArray<string>;
}

interface SymbolMatch {
  readonly name: string;
  readonly kind: string;
  readonly line: number;
  readonly exported: boolean;
  readonly signature: string;
}

const SYMBOL_PATTERNS: ReadonlyArray<{
  readonly kind: string;
  readonly regex: RegExp;
  readonly exported: boolean;
}> = [
  {
    kind: "function",
    regex: /^(export\s+default\s+|export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
    exported: false,
  },
  {
    kind: "class",
    regex: /^(export\s+default\s+|export\s+)?class\s+([A-Za-z_$][\w$]*)\b/,
    exported: false,
  },
  {
    kind: "interface",
    regex: /^(export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/,
    exported: false,
  },
  {
    kind: "type",
    regex: /^(export\s+)?type\s+([A-Za-z_$][\w$]*)\b/,
    exported: false,
  },
  {
    kind: "enum",
    regex: /^(export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/,
    exported: false,
  },
  {
    kind: "const",
    regex:
      /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^=]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    exported: false,
  },
  {
    kind: "const",
    regex: /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
    exported: false,
  },
];

const DYNAMIC_TOOL_DEFINITIONS = [
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
  {
    name: "find_symbols",
    description: "Find top-level symbols in files.",
    instructionExample: '{"paths": string[], "maxResultsPerFile"?: number}',
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
        },
        maxResultsPerFile: { type: "integer", minimum: 1 },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  {
    name: "find_exported_api",
    description: "Find exported top-level symbols in files.",
    instructionExample: '{"paths": string[], "maxResultsPerFile"?: number}',
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
        },
        maxResultsPerFile: { type: "integer", minimum: 1 },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  {
    name: "find_references",
    description: "Find likely import/call/reference sites for a symbol or string.",
    instructionExample:
      '{"query": string, "glob"?: string, "caseSensitive"?: boolean, "exactWord"?: boolean, "maxResults"?: number}',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        glob: { type: "string" },
        caseSensitive: { type: "boolean" },
        exactWord: { type: "boolean" },
        maxResults: { type: "integer", minimum: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "find_text_with_context",
    description: "Find text matches and return surrounding line context.",
    instructionExample:
      '{"query": string, "glob"?: string, "caseSensitive"?: boolean, "contextLines"?: number, "maxResults"?: number}',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        glob: { type: "string" },
        caseSensitive: { type: "boolean" },
        contextLines: { type: "integer", minimum: 0 },
        maxResults: { type: "integer", minimum: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "list_directory",
    description: "List a directory tree relative to the workspace root.",
    instructionExample:
      '{"path"?: string, "maxDepth"?: number, "includeFiles"?: boolean, "includeDirectories"?: boolean, "maxResults"?: number}',
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxDepth: { type: "integer", minimum: 0 },
        includeFiles: { type: "boolean" },
        includeDirectories: { type: "boolean" },
        maxResults: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stat_files",
    description: "Return file metadata like size, line count, extension, and binary/text detection.",
    instructionExample: '{"paths": string[], "maxBytes"?: number}',
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
        },
        maxBytes: { type: "integer", minimum: 1 },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
] satisfies ReadonlyArray<CodexDynamicToolDefinition>;

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

const TOOL_INSTRUCTIONS = buildDynamicToolInstructions();

export const CODEX_DYNAMIC_TOOL_DEVELOPER_INSTRUCTIONS = TOOL_INSTRUCTIONS;

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
  const query = asString(record.query)?.trim();
  const mode = record.mode;
  if (!query || (mode !== "path" && mode !== "content")) {
    return undefined;
  }
  const args: {
    query: string;
    mode: SearchMode;
    glob?: string;
    caseSensitive?: boolean;
    maxResults?: number;
  } = {
    query,
    mode,
  };
  const glob = asString(record.glob)?.trim();
  const caseSensitive = asBoolean(record.caseSensitive);
  const maxResults = asSafeInteger(record.maxResults);
  if (glob) {
    args.glob = glob;
  }
  if (caseSensitive !== undefined) {
    args.caseSensitive = caseSensitive;
  }
  if (maxResults !== undefined) {
    args.maxResults = maxResults;
  }
  return args;
}

function parsePathsArray(record: Record<string, unknown>): string[] | undefined {
  const rawPaths = record.paths;
  if (!Array.isArray(rawPaths)) {
    const rawPath = asString(record.path)?.trim();
    return rawPath ? [rawPath] : undefined;
  }

  const paths: string[] = [];
  for (const rawPath of rawPaths) {
    const normalized = asString(rawPath)?.trim();
    if (normalized) {
      paths.push(normalized);
    }
  }
  return paths.length > 0 ? paths : undefined;
}

function parseReadFilesArgs(value: unknown): ReadFilesArgs | undefined {
  const record = asRecord(value);
  const requests = record?.requests;
  if (!Array.isArray(requests) || requests.length === 0) {
    return undefined;
  }

  const normalizedRequests: ReadFileRequest[] = [];
  for (const request of requests) {
    const requestRecord = asRecord(request);
    const requestPath = asString(requestRecord?.path)?.trim();
    if (!requestPath) {
      continue;
    }
    const normalizedRequest: {
      path: string;
      startLine?: number;
      endLine?: number;
      aroundLine?: number;
      lineCount?: number;
      maxBytes?: number;
    } = { path: requestPath };
    const startLine = asSafeInteger(requestRecord?.startLine);
    const endLine = asSafeInteger(requestRecord?.endLine);
    const aroundLine = asSafeInteger(requestRecord?.aroundLine);
    const lineCount = asSafeInteger(requestRecord?.lineCount);
    const maxBytes = asSafeInteger(requestRecord?.maxBytes);
    if (startLine !== undefined) {
      normalizedRequest.startLine = startLine;
    }
    if (endLine !== undefined) {
      normalizedRequest.endLine = endLine;
    }
    if (aroundLine !== undefined) {
      normalizedRequest.aroundLine = aroundLine;
    }
    if (lineCount !== undefined) {
      normalizedRequest.lineCount = lineCount;
    }
    if (maxBytes !== undefined) {
      normalizedRequest.maxBytes = maxBytes;
    }
    normalizedRequests.push(normalizedRequest);
  }

  return normalizedRequests.length > 0 ? { requests: normalizedRequests } : undefined;
}

function parseFindSymbolsArgs(value: unknown): FindSymbolsArgs | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const paths = parsePathsArray(record);
  if (!paths) {
    return undefined;
  }
  const args: { paths: string[]; maxResultsPerFile?: number } = { paths };
  const maxResultsPerFile = asSafeInteger(record.maxResultsPerFile);
  if (maxResultsPerFile !== undefined) {
    args.maxResultsPerFile = maxResultsPerFile;
  }
  return args;
}

function parseFindExportedApiArgs(value: unknown): FindExportedApiArgs | undefined {
  return parseFindSymbolsArgs(value);
}

function parseFindReferencesArgs(value: unknown): FindReferencesArgs | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const query = asString(record.query)?.trim();
  if (!query) {
    return undefined;
  }
  const args: {
    query: string;
    glob?: string;
    caseSensitive?: boolean;
    exactWord?: boolean;
    maxResults?: number;
  } = {
    query,
  };
  const glob = asString(record.glob)?.trim();
  const caseSensitive = asBoolean(record.caseSensitive);
  const exactWord = asBoolean(record.exactWord);
  const maxResults = asSafeInteger(record.maxResults);
  if (glob) {
    args.glob = glob;
  }
  if (caseSensitive !== undefined) {
    args.caseSensitive = caseSensitive;
  }
  if (exactWord !== undefined) {
    args.exactWord = exactWord;
  }
  if (maxResults !== undefined) {
    args.maxResults = maxResults;
  }
  return args;
}

function parseListDirectoryArgs(value: unknown): ListDirectoryArgs | undefined {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const args: {
    path?: string;
    maxDepth?: number;
    includeFiles?: boolean;
    includeDirectories?: boolean;
    maxResults?: number;
  } = {};
  const relativePath = asString(record.path)?.trim();
  const maxDepth = asSafeInteger(record.maxDepth);
  const includeFiles = asBoolean(record.includeFiles);
  const includeDirectories = asBoolean(record.includeDirectories);
  const maxResults = asSafeInteger(record.maxResults);
  if (relativePath) {
    args.path = relativePath;
  }
  if (maxDepth !== undefined) {
    args.maxDepth = maxDepth;
  }
  if (includeFiles !== undefined) {
    args.includeFiles = includeFiles;
  }
  if (includeDirectories !== undefined) {
    args.includeDirectories = includeDirectories;
  }
  if (maxResults !== undefined) {
    args.maxResults = maxResults;
  }
  return args;
}

function parseStatFilesArgs(value: unknown): StatFilesArgs | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const paths = parsePathsArray(record);
  if (!paths) {
    return undefined;
  }
  const args: { paths: string[]; maxBytes?: number } = { paths };
  const maxBytes = asSafeInteger(record.maxBytes);
  if (maxBytes !== undefined) {
    args.maxBytes = maxBytes;
  }
  return args;
}

function parseFindTextWithContextArgs(value: unknown): FindTextWithContextArgs | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const query = asString(record.query)?.trim();
  if (!query) {
    return undefined;
  }
  const args: {
    query: string;
    glob?: string;
    caseSensitive?: boolean;
    contextLines?: number;
    maxResults?: number;
  } = { query };
  const glob = asString(record.glob)?.trim();
  const caseSensitive = asBoolean(record.caseSensitive);
  const contextLines = asSafeInteger(record.contextLines);
  const maxResults = asSafeInteger(record.maxResults);
  if (glob) {
    args.glob = glob;
  }
  if (caseSensitive !== undefined) {
    args.caseSensitive = caseSensitive;
  }
  if (contextLines !== undefined) {
    args.contextLines = contextLines;
  }
  if (maxResults !== undefined) {
    args.maxResults = maxResults;
  }
  return args;
}

function resolveWorkspacePath(cwd: string, inputPath: string): WorkspacePath {
  const absolutePath = path.resolve(cwd, inputPath);
  const relativePath = toPosixPath(path.relative(cwd, absolutePath));
  if (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`Path must stay within the workspace root: ${inputPath}`);
  }
  return {
    absolutePath,
    relativePath,
    displayPath: `./${relativePath}`,
  };
}

function splitFileLines(contents: string): string[] {
  const normalized = contents.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4_096));
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

async function readWorkspaceTextFile(
  workspacePath: WorkspacePath,
  maxBytes: number,
): Promise<ReadTextFileResult> {
  const buffer = await fs.readFile(workspacePath.absolutePath);
  const sizeBytes = buffer.byteLength;
  const cappedBytes = clampReadBytes(maxBytes);
  const truncated = sizeBytes > cappedBytes;
  const sample = buffer.subarray(0, cappedBytes);
  const binary = isProbablyBinary(sample);
  const contents = sample.toString("utf8");
  const lines = binary ? [] : splitFileLines(contents);
  return {
    contents,
    sizeBytes,
    truncated,
    binary,
    lines,
  };
}

function normalizeLineRange(input: {
  readonly startLine?: number;
  readonly endLine?: number;
  readonly aroundLine?: number;
  readonly lineCount?: number;
  readonly totalLines: number;
}): { startLine: number; endLine: number } {
  if (input.aroundLine !== undefined) {
    const aroundLine = Math.max(1, input.aroundLine);
    const lineCount = clampCount(input.lineCount, DEFAULT_AROUND_LINE_COUNT, 400);
    const halfWindow = Math.max(0, Math.floor((lineCount - 1) / 2));
    const startLine = Math.max(1, aroundLine - halfWindow);
    const endLine = Math.min(
      Math.max(input.totalLines, 1),
      startLine + Math.max(0, lineCount - 1),
    );
    return {
      startLine,
      endLine,
    };
  }

  const startLine = input.startLine === undefined ? 1 : Math.max(1, input.startLine);
  const endLine =
    input.endLine === undefined ? Math.max(input.totalLines, startLine) : Math.max(startLine, input.endLine);
  return {
    startLine,
    endLine,
  };
}

function formatLineBlock(input: {
  readonly lines: ReadonlyArray<string>;
  readonly startLine: number;
  readonly endLine: number;
}): string {
  const selectedLines =
    input.lines.length === 0
      ? []
      : input.lines.slice(Math.max(0, input.startLine - 1), Math.min(input.endLine, input.lines.length));
  if (selectedLines.length === 0) {
    return input.lines.length === 0 ? "(empty file)" : "(no lines in requested range)";
  }
  const lineNumberWidth = String(Math.max(input.startLine, input.endLine, 1)).length;
  return selectedLines
    .map(
      (line, index) =>
        `${String(input.startLine + index).padStart(lineNumberWidth, " ")} | ${line}`,
    )
    .join("\n");
}

async function runRipgrepContentSearch(
  input: {
    readonly cwd: string;
    readonly query: string;
    readonly glob?: string;
    readonly caseSensitive?: boolean;
    readonly exactWord?: boolean;
    readonly maxResults?: number;
  },
): Promise<{
  matches: SearchMatch[];
  totalMatches: number;
  truncated: boolean;
}> {
  const maxResults = clampMaxResults(input.maxResults);
  const rgArgs = ["--json", "--line-number", "--fixed-strings"];
  if (!input.caseSensitive) {
    rgArgs.push("--ignore-case");
  }
  if (input.exactWord) {
    rgArgs.push("--word-regexp");
  }
  if (input.glob) {
    rgArgs.push("--glob", input.glob);
  }
  rgArgs.push(input.query, ".");

  const searchResult = await runProcess("rg", rgArgs, {
    cwd: input.cwd,
    timeoutMs: 20_000,
    maxBufferBytes: 16 * 1024 * 1024,
    outputMode: "truncate",
    allowNonZeroExit: true,
  });
  if (searchResult.code !== 0 && searchResult.code !== 1) {
    throw new Error(searchResult.stderr.trim() || "Workspace content search failed.");
  }

  const matches: SearchMatch[] = [];
  let totalMatches = 0;
  for (const line of searchResult.stdout.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record?.type !== "match") {
      continue;
    }
    const data = asRecord(record.data);
    const pathRecord = asRecord(data?.path);
    const linesRecord = asRecord(data?.lines);
    const relativePath = asString(pathRecord?.text);
    const preview = asString(linesRecord?.text)?.replace(/\r?\n$/, "");
    const lineNumber = asSafeInteger(data?.line_number);
    if (!relativePath || preview === undefined || lineNumber === undefined) {
      continue;
    }
    totalMatches += 1;
    if (matches.length < maxResults) {
      const displayPath = normalizeDisplayPath(`./${toPosixPath(relativePath)}`);
      matches.push({
        path: displayPath,
        line: lineNumber,
        preview,
      });
    }
  }

  return {
    matches,
    totalMatches,
    truncated: totalMatches > maxResults || Boolean(searchResult.stdoutTruncated),
  };
}

async function searchWorkspacePaths(args: SearchWorkspaceArgs, cwd: string): Promise<CodexDynamicToolResult> {
  const maxResults = clampMaxResults(args.maxResults);
  const rgArgs = ["--files"];
  if (args.glob) {
    rgArgs.push("--glob", args.glob);
  }

  const listed = await runProcess("rg", rgArgs, {
    cwd,
    timeoutMs: 20_000,
    maxBufferBytes: 16 * 1024 * 1024,
    outputMode: "truncate",
  });
  const query = args.caseSensitive ? args.query : args.query.toLowerCase();
  const candidates = listed.stdout
    .split(/\r?\n/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => {
      const comparable = args.caseSensitive ? entry : entry.toLowerCase();
      return comparable.includes(query);
    });
  const matches = candidates.slice(0, maxResults).map((entry) => `./${toPosixPath(entry)}`);
  const lines = [`PATH SEARCH "${args.query}"`];
  if (matches.length === 0) {
    lines.push("(no matches)");
  } else {
    for (const match of matches) {
      lines.push(`- ${match}`);
    }
  }

  return formatToolTextResult(lines.join("\n"), {
    mode: "path",
    query: args.query,
    matches: matches.map((match) => ({ path: match })),
    truncated: candidates.length > maxResults || Boolean(listed.stdoutTruncated),
  });
}

async function searchWorkspaceContent(
  args: SearchWorkspaceArgs,
  cwd: string,
): Promise<CodexDynamicToolResult> {
  const searchInput: {
    cwd: string;
    query: string;
    glob?: string;
    caseSensitive?: boolean;
    maxResults?: number;
  } = {
    cwd,
    query: args.query,
  };
  if (args.glob !== undefined) {
    searchInput.glob = args.glob;
  }
  if (args.caseSensitive !== undefined) {
    searchInput.caseSensitive = args.caseSensitive;
  }
  if (args.maxResults !== undefined) {
    searchInput.maxResults = args.maxResults;
  }
  const search = await runRipgrepContentSearch(searchInput);
  const lines = [`CONTENT SEARCH "${args.query}"`];
  if (search.matches.length === 0) {
    lines.push("(no matches)");
  } else {
    for (const match of search.matches) {
      lines.push(`- ${match.path}:${match.line}: ${match.preview}`);
    }
  }

  return formatToolTextResult(lines.join("\n"), {
    mode: "content",
    query: args.query,
    matches: search.matches,
    truncated: search.truncated,
  });
}

async function readWorkspaceFiles(args: ReadFilesArgs, cwd: string): Promise<CodexDynamicToolResult> {
  const fileResults: Array<Record<string, unknown>> = [];
  const formattedResults: string[] = [];

  for (const request of args.requests) {
    try {
      const workspacePath = resolveWorkspacePath(cwd, request.path);
      const file = await readWorkspaceTextFile(workspacePath, request.maxBytes ?? DEFAULT_READ_FILE_BYTES);
      if (file.binary) {
        const binaryResult = {
          path: workspacePath.displayPath,
          sizeBytes: file.sizeBytes,
          binary: true,
        };
        fileResults.push(binaryResult);
        formattedResults.push(
          [`FILE ${workspacePath.relativePath}`, `BINARY true`, `SIZE ${file.sizeBytes}`].join("\n"),
        );
        continue;
      }

      const range = normalizeLineRange({
        ...(request.startLine !== undefined ? { startLine: request.startLine } : {}),
        ...(request.endLine !== undefined ? { endLine: request.endLine } : {}),
        ...(request.aroundLine !== undefined ? { aroundLine: request.aroundLine } : {}),
        ...(request.lineCount !== undefined ? { lineCount: request.lineCount } : {}),
        totalLines: file.lines.length,
      });
      const effectiveEndLine = Math.min(range.endLine, Math.max(file.lines.length, range.startLine));
      const body = formatLineBlock({
        lines: file.lines,
        startLine: range.startLine,
        endLine: effectiveEndLine,
      });
      formattedResults.push(
        [
          `FILE ${workspacePath.relativePath}`,
          `LINES ${range.startLine}-${effectiveEndLine}`,
          `TOTAL_LINES ${file.lines.length}`,
          ...(file.truncated ? ["TRUNCATED true"] : []),
          body,
        ].join("\n"),
      );
      fileResults.push({
        path: workspacePath.displayPath,
        sizeBytes: file.sizeBytes,
        totalLines: file.lines.length,
        truncated: file.truncated,
        binary: false,
        startLine: range.startLine,
        endLine: effectiveEndLine,
        content: file.lines
          .slice(Math.max(0, range.startLine - 1), Math.min(effectiveEndLine, file.lines.length))
          .join("\n"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      formattedResults.push(`FILE ${request.path}\nERROR ${message}`);
      fileResults.push({
        path: request.path,
        error: message,
      });
    }
  }

  return formatToolTextResult(formattedResults.join("\n\n"), {
    files: fileResults,
  });
}

function collectSymbols(input: {
  readonly lines: ReadonlyArray<string>;
  readonly exportsOnly: boolean;
  readonly maxResultsPerFile: number;
}): SymbolMatch[] {
  const matches: SymbolMatch[] = [];
  for (let index = 0; index < input.lines.length; index += 1) {
    const line = input.lines[index];
    if (line === undefined) {
      continue;
    }
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) {
      continue;
    }
    if (trimmed.length !== line.length) {
      continue;
    }
    for (const pattern of SYMBOL_PATTERNS) {
      const match = pattern.regex.exec(trimmed);
      if (!match) {
        continue;
      }
      const prefix = match[1] ?? "";
      const exported = prefix.includes("export");
      if (input.exportsOnly && !exported) {
        break;
      }
      const name = match[2];
      if (!name) {
        break;
      }
      matches.push({
        name,
        kind: pattern.kind,
        line: index + 1,
        exported,
        signature: trimmed.slice(0, 200),
      });
      break;
    }
    if (matches.length >= input.maxResultsPerFile) {
      break;
    }
  }
  return matches;
}

async function findSymbolsInFiles(
  args: FindSymbolsArgs,
  cwd: string,
  exportsOnly: boolean,
  title: string,
): Promise<CodexDynamicToolResult> {
  const maxResultsPerFile = clampCount(args.maxResultsPerFile, 30, MAX_SYMBOLS_PER_FILE);
  const formattedResults: string[] = [];
  const files: Array<Record<string, unknown>> = [];

  for (const requestedPath of args.paths) {
    try {
      const workspacePath = resolveWorkspacePath(cwd, requestedPath);
      const file = await readWorkspaceTextFile(workspacePath, DEFAULT_READ_FILE_BYTES);
      if (file.binary) {
        formattedResults.push(`FILE ${workspacePath.relativePath}\nBINARY true`);
        files.push({
          path: workspacePath.displayPath,
          binary: true,
        });
        continue;
      }
      const symbols = collectSymbols({
        lines: file.lines,
        exportsOnly,
        maxResultsPerFile,
      });
      const lines = [`FILE ${workspacePath.relativePath}`];
      if (symbols.length === 0) {
        lines.push("(no symbols found)");
      } else {
        for (const symbol of symbols) {
          lines.push(
            `- ${symbol.kind} ${symbol.name} @ ${symbol.line}${symbol.exported ? " exported" : ""}`,
          );
        }
      }
      formattedResults.push(lines.join("\n"));
      files.push({
        path: workspacePath.displayPath,
        binary: false,
        symbols,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      formattedResults.push(`FILE ${requestedPath}\nERROR ${message}`);
      files.push({
        path: requestedPath,
        error: message,
      });
    }
  }

  return formatToolTextResult([title, ...formattedResults].join("\n\n"), {
    files,
  });
}

async function findReferences(args: FindReferencesArgs, cwd: string): Promise<CodexDynamicToolResult> {
  const searchInput: {
    cwd: string;
    query: string;
    glob?: string;
    caseSensitive?: boolean;
    exactWord?: boolean;
    maxResults?: number;
  } = {
    cwd,
    query: args.query,
  };
  if (args.glob !== undefined) {
    searchInput.glob = args.glob;
  }
  if (args.caseSensitive !== undefined) {
    searchInput.caseSensitive = args.caseSensitive;
  }
  if (args.exactWord !== undefined) {
    searchInput.exactWord = args.exactWord;
  }
  if (args.maxResults !== undefined) {
    searchInput.maxResults = args.maxResults;
  }
  const search = await runRipgrepContentSearch(searchInput);
  const lines = [`REFERENCES "${args.query}"`];
  if (search.matches.length === 0) {
    lines.push("(no matches)");
  } else {
    for (const match of search.matches) {
      lines.push(`- ${match.path}:${match.line}: ${match.preview}`);
    }
  }
  return formatToolTextResult(lines.join("\n"), {
    query: args.query,
    matches: search.matches,
    truncated: search.truncated,
  });
}

async function findTextWithContext(
  args: FindTextWithContextArgs,
  cwd: string,
): Promise<CodexDynamicToolResult> {
  const searchInput: {
    cwd: string;
    query: string;
    glob?: string;
    caseSensitive?: boolean;
    maxResults?: number;
  } = {
    cwd,
    query: args.query,
  };
  if (args.glob !== undefined) {
    searchInput.glob = args.glob;
  }
  if (args.caseSensitive !== undefined) {
    searchInput.caseSensitive = args.caseSensitive;
  }
  if (args.maxResults !== undefined) {
    searchInput.maxResults = args.maxResults;
  }
  const search = await runRipgrepContentSearch(searchInput);
  const contextLines = clampCount(args.contextLines, DEFAULT_CONTEXT_LINES, 20);
  const formattedResults: string[] = [`TEXT WITH CONTEXT "${args.query}"`];
  const matchesWithContext: Array<Record<string, unknown>> = [];

  if (search.matches.length === 0) {
    formattedResults.push("(no matches)");
  }

  for (const match of search.matches) {
    try {
      const workspacePath = resolveWorkspacePath(cwd, match.path);
      const file = await readWorkspaceTextFile(workspacePath, DEFAULT_READ_FILE_BYTES);
      if (file.binary) {
        formattedResults.push(`MATCH ${match.path}:${match.line}\nBINARY true`);
        matchesWithContext.push({
          ...match,
          binary: true,
        });
        continue;
      }
      const startLine = Math.max(1, match.line - contextLines);
      const endLine = Math.min(file.lines.length, match.line + contextLines);
      const context = formatLineBlock({
        lines: file.lines,
        startLine,
        endLine,
      });
      const displayPath = normalizeDisplayPath(match.path);
      formattedResults.push(`MATCH ${displayPath}:${startLine}-${endLine}\n${context}`);
      matchesWithContext.push({
        path: displayPath,
        line: match.line,
        preview: match.preview,
        startLine,
        endLine,
        context: file.lines.slice(Math.max(0, startLine - 1), endLine).join("\n"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const displayPath = normalizeDisplayPath(match.path);
      formattedResults.push(`MATCH ${displayPath}:${match.line}\nERROR ${message}`);
      matchesWithContext.push({
        path: displayPath,
        line: match.line,
        preview: match.preview,
        error: message,
      });
    }
  }

  return formatToolTextResult(formattedResults.join("\n\n"), {
    query: args.query,
    matches: matchesWithContext,
    truncated: search.truncated,
  });
}

async function listDirectory(args: ListDirectoryArgs, cwd: string): Promise<CodexDynamicToolResult> {
  const rootPath = args.path ? resolveWorkspacePath(cwd, args.path) : undefined;
  const rootAbsolutePath = rootPath?.absolutePath ?? cwd;
  const rootRelativePath = rootPath?.relativePath ?? ".";
  const maxDepth = clampCount(args.maxDepth, 2, MAX_DIRECTORY_DEPTH);
  const maxResults = clampCount(args.maxResults, 100, MAX_DIRECTORY_RESULTS);
  const includeFiles = args.includeFiles ?? true;
  const includeDirectories = args.includeDirectories ?? true;

  const entries: Array<{ path: string; kind: "file" | "directory"; depth: number }> = [];
  const queue: Array<{ absolutePath: string; relativePath: string; depth: number }> = [
    { absolutePath: rootAbsolutePath, relativePath: rootRelativePath, depth: 0 },
  ];

  while (queue.length > 0 && entries.length < maxResults) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const dirents = await fs.readdir(current.absolutePath, { withFileTypes: true });
    dirents.sort((left, right) => left.name.localeCompare(right.name));
    for (const dirent of dirents) {
      if (entries.length >= maxResults) {
        break;
      }
      const childRelativePath =
        current.relativePath === "."
          ? dirent.name
          : toPosixPath(path.join(current.relativePath, dirent.name));
      const childAbsolutePath = path.join(current.absolutePath, dirent.name);
      if (dirent.isDirectory()) {
        if (includeDirectories) {
          entries.push({
            path: `./${childRelativePath}`,
            kind: "directory",
            depth: current.depth + 1,
          });
        }
        if (current.depth + 1 < maxDepth) {
          queue.push({
            absolutePath: childAbsolutePath,
            relativePath: childRelativePath,
            depth: current.depth + 1,
          });
        }
        continue;
      }
      if (dirent.isFile() && includeFiles) {
        entries.push({
          path: `./${childRelativePath}`,
          kind: "file",
          depth: current.depth + 1,
        });
      }
    }
  }

  const lines = [`DIRECTORY LIST "${rootRelativePath}"`];
  if (entries.length === 0) {
    lines.push("(no entries)");
  } else {
    for (const entry of entries) {
      lines.push(`- [${entry.kind}] ${entry.path}`);
    }
  }
  return formatToolTextResult(lines.join("\n"), {
    path: rootRelativePath,
    entries,
    truncated: entries.length >= maxResults,
  });
}

async function statFiles(args: StatFilesArgs, cwd: string): Promise<CodexDynamicToolResult> {
  const maxBytes = clampReadBytes(args.maxBytes);
  const stats: Array<Record<string, unknown>> = [];
  const formattedResults: string[] = ["FILE STATS"];

  for (const requestedPath of args.paths) {
    try {
      const workspacePath = resolveWorkspacePath(cwd, requestedPath);
      const stat = await fs.stat(workspacePath.absolutePath);
      if (stat.isDirectory()) {
        const directoryStat = {
          path: workspacePath.displayPath,
          type: "directory",
          sizeBytes: stat.size,
        };
        stats.push(directoryStat);
        formattedResults.push(
          [`PATH ${workspacePath.relativePath}`, "TYPE directory", `SIZE ${stat.size}`].join("\n"),
        );
        continue;
      }

      const file = await readWorkspaceTextFile(workspacePath, maxBytes);
      const fileStat = {
        path: workspacePath.displayPath,
        type: "file",
        sizeBytes: stat.size,
        extension: path.extname(workspacePath.relativePath),
        binary: file.binary,
        truncated: file.truncated,
        lineCount: file.binary || file.truncated ? null : file.lines.length,
      };
      stats.push(fileStat);
      formattedResults.push(
        [
          `PATH ${workspacePath.relativePath}`,
          "TYPE file",
          `SIZE ${stat.size}`,
          `EXT ${path.extname(workspacePath.relativePath) || "(none)"}`,
          `BINARY ${file.binary ? "true" : "false"}`,
          ...(file.binary || file.truncated
            ? [file.truncated ? "LINE_COUNT unavailable (truncated)" : "LINE_COUNT unavailable (binary)"]
            : [`LINE_COUNT ${file.lines.length}`]),
        ].join("\n"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      formattedResults.push(`PATH ${requestedPath}\nERROR ${message}`);
      stats.push({
        path: requestedPath,
        error: message,
      });
    }
  }

  return formatToolTextResult(formattedResults.join("\n\n"), {
    files: stats,
  });
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
        "search_workspace arguments must be an object with query, mode, and optional glob/caseSensitive/maxResults fields.",
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

  if (input.tool === "find_symbols") {
    const args = parseFindSymbolsArgs(input.arguments);
    if (!args) {
      return formatToolErrorResult(
        "find_symbols arguments must include a non-empty paths array.",
      );
    }
    return findSymbolsInFiles(args, input.cwd, false, "SYMBOLS");
  }

  if (input.tool === "find_exported_api") {
    const args = parseFindExportedApiArgs(input.arguments);
    if (!args) {
      return formatToolErrorResult(
        "find_exported_api arguments must include a non-empty paths array.",
      );
    }
    return findSymbolsInFiles(args, input.cwd, true, "EXPORTED API");
  }

  if (input.tool === "find_references") {
    const args = parseFindReferencesArgs(input.arguments);
    if (!args) {
      return formatToolErrorResult(
        "find_references arguments must include a query string.",
      );
    }
    return findReferences(args, input.cwd);
  }

  if (input.tool === "find_text_with_context") {
    const args = parseFindTextWithContextArgs(input.arguments);
    if (!args) {
      return formatToolErrorResult(
        "find_text_with_context arguments must include a query string.",
      );
    }
    return findTextWithContext(args, input.cwd);
  }

  if (input.tool === "list_directory") {
    const args = parseListDirectoryArgs(input.arguments);
    if (!args) {
      return formatToolErrorResult("list_directory arguments must be an object.");
    }
    return listDirectory(args, input.cwd);
  }

  if (input.tool === "stat_files") {
    const args = parseStatFilesArgs(input.arguments);
    if (!args) {
      return formatToolErrorResult("stat_files arguments must include a non-empty paths array.");
    }
    return statFiles(args, input.cwd);
  }

  return formatToolErrorResult(`Unsupported dynamic tool: ${input.tool}`);
}
