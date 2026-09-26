import { spawn } from "node:child_process";
import { access, constants as fsConstants, mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

export const KETCH_VERSION = "0.17.1";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const MAX_RESULT_BYTES = 50 * 1024;
export const MAX_RESULT_LINES = 2_000;
export const MAX_URLS = 20;
export const MAX_CRAWL_DEPTH = 5;
export const MAX_CRAWL_PAGES = 100;

export interface KetchRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
  /** Explicit operator configuration only; the parent environment is not inherited. */
  env?: NodeJS.ProcessEnv;
  /** Called while a command is running, including periodic keep-alive updates. */
  progress?: (message: string) => void;
  /** Maximum newline-delimited JSON records retained from a streaming command. */
  maxRecords?: number;
  /** Override the installed ketch launcher. This is executed directly, never through a shell. */
  binary?: string;
  /**
   * Absolute path to an operator Ketch config.json, passed as KETCH_CONFIG.
   * Defaults to PI_RESEARCH_KETCH_CONFIG; HOME and cache stay temporary.
   */
  ketchConfig?: string;
}

export interface KetchRunResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  code: number;
  parsed: unknown;
  limited?: boolean;
}

export interface KetchErrorOptions {
  code?: string;
  cause?: unknown;
  stderr?: string;
}

export class KetchError extends Error {
  readonly code: string;
  readonly stderr?: string;

  constructor(message: string, options: KetchErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "KetchError";
    this.code = options.code ?? "KETCH_ERROR";
    this.stderr = options.stderr;
  }
}

export class KetchCancelledError extends KetchError {
  constructor(message = "ketch operation cancelled", options: KetchErrorOptions = {}) {
    super(message, { ...options, code: "KETCH_CANCELLED" });
    this.name = "KetchCancelledError";
  }
}

export class KetchTimeoutError extends KetchError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, options: KetchErrorOptions = {}) {
    super(`ketch operation timed out after ${timeoutMs}ms`, {
      ...options,
      code: "KETCH_TIMEOUT",
    });
    this.name = "KetchTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class KetchCommandError extends KetchError {
  readonly exitCode: number;

  constructor(exitCode: number, stderr: string, options: KetchErrorOptions = {}) {
    const suffix = ""; // Provider diagnostics can contain credentials; never echo them.
    super(`ketch exited with code ${exitCode}${suffix}`, {
      ...options,
      code: "KETCH_COMMAND_FAILED",
      stderr,
    });
    this.name = "KetchCommandError";
    this.exitCode = exitCode;
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return false;
  const [first, second] = octets as [number, number, number, number];
  return first === 0 || first === 10 || first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && second >= 18 && second <= 19) ||
    (first === 198 && second === 51) ||
    (first === 203 && second === 0) ||
    first >= 224;
}

function isPrivateIpv6(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") ||
      value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) {
    return true;
  }
  // WHATWG URL normalizes dotted IPv4-mapped addresses to hexadecimal groups.
  // Reject the entire mapped range rather than ambiguously parsing it.
  return value.startsWith("::ffff:") || value.startsWith("ff") || value.startsWith("2001:db8:");
}

function isPrivateLiteral(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return normalized === "localhost" || normalized.endsWith(".localhost") ||
    isPrivateIpv4(normalized) || (normalized.includes(":") && isPrivateIpv6(normalized));
}

export function validateHttpUrl(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new KetchError("A URL is required.", { code: "INVALID_URL" });
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch (cause) {
    throw new KetchError(`Invalid URL: ${value}`, { code: "INVALID_URL", cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new KetchError("Only http:// and https:// URLs are supported.", {
      code: "INVALID_URL_SCHEME",
    });
  }
  if (url.username || url.password) {
    throw new KetchError("URL userinfo is not supported.", { code: "INVALID_URL" });
  }
  if (isPrivateLiteral(url.hostname)) {
    throw new KetchError("Private or local URL literals are not supported.", { code: "INVALID_URL" });
  }
  return url.toString();
}

export function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new KetchError(`${name} must be an integer from ${minimum} to ${maximum}.`, {
      code: "INVALID_OPTION",
    });
  }
  return selected;
}

function boundedTimeout(timeoutMs: number | undefined): number {
  return boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS, "timeoutMs");
}

function boundedOutputBytes(maxOutputBytes: number | undefined): number {
  return boundedInteger(
    maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    1,
    MAX_OUTPUT_BYTES,
    "maxOutputBytes",
  );
}

function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Some streaming commands emit one JSON value per line. Preserve all valid
    // records while still allowing the CLI's human-readable output as a string.
    const records: unknown[] = [];
    for (const line of text.split("\n")) {
      try {
        records.push(JSON.parse(line) as unknown);
      } catch {
        return text;
      }
    }
    return records.length > 0 ? records : text;
  }
}

function resolveNativeBinary(require: NodeRequire): { command: string; prefixArgs: string[] } | undefined {
  // ketch-cli's optional packages contain the executable itself. Resolve the
  // package file rather than starting the JS launcher and its native child.
  if (!((process.platform === "darwin" || process.platform === "linux" || process.platform === "win32") &&
      (process.arch === "x64" || process.arch === "arm64"))) return undefined;
  const packageName = `@ketch-cli/${process.platform}-${process.arch}`;
  const filename = process.platform === "win32" ? "ketch.exe" : "ketch";
  try {
    const command = require.resolve(`${packageName}/bin/${filename}`);
    return { command, prefixArgs: [] };
  } catch {
    // npm may omit an optional dependency on an unsupported or partially
    // installed platform. The pinned JS launcher remains a safe fallback.
    return undefined;
  }
}

function resolveInstalledLauncher(): { command: string; prefixArgs: string[] } {
  const require = createRequire(import.meta.url);
  const native = resolveNativeBinary(require);
  if (native) return native;
  try {
    const launcher = require.resolve("ketch-cli/bin/ketch.js");
    return { command: process.execPath, prefixArgs: [launcher] };
  } catch (cause) {
    throw new KetchError(
      "The pinned ketch-cli launcher is not installed. Run npm install in this package.",
      { code: "KETCH_NOT_INSTALLED", cause },
    );
  }
}

export function resolveKetchCommand(binary?: string): {
  command: string;
  prefixArgs: string[];
} {
  const override = binary ?? process.env.KETCH_BIN ?? process.env.KETCH_BINARY;
  if (!override) return resolveInstalledLauncher();
  // JS fixture/launcher overrides are run by the current Node executable so
  // tests and explicit local integrations do not depend on a POSIX shebang.
  if (override.toLowerCase().endsWith(".js")) {
    return { command: process.execPath, prefixArgs: [override] };
  }
  // Native overrides are passed to spawn directly; shell metacharacters are
  // never interpreted. Bare names remain valid PATH/PATHEXT lookups.
  return { command: override, prefixArgs: [] };
}

interface SpawnLike {
  pid?: number;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  once(event: string, listener: (...args: unknown[]) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Search backends that PI_RESEARCH_KETCH_BACKEND may select. */
export const KETCH_SEARCH_BACKENDS = [
  "brave", "ddg", "searxng", "exa", "firecrawl", "keenable", "tavily", "parallel", "serpbase", "degoog",
] as const;

/**
 * Map an operator backend setting to Ketch search flags: one allowlisted name
 * becomes `--backend <name>`, `multi:<a,b>` becomes `--multi=<a,b>`.
 */
export function ketchBackendArgs(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  const allowed = new Set<string>(KETCH_SEARCH_BACKENDS);
  const invalid = () => new KetchError(
    `PI_RESEARCH_KETCH_BACKEND must be one of ${KETCH_SEARCH_BACKENDS.join(", ")} or multi:<comma list of those names>.`,
    { code: "INVALID_OPTION" },
  );
  const setting = value.trim();
  if (setting.startsWith("multi:")) {
    const names = setting.slice("multi:".length).split(",").map((name) => name.trim());
    if (names.length === 0 || names.some((name) => !allowed.has(name)) || new Set(names).size !== names.length) throw invalid();
    return [`--multi=${names.join(",")}`];
  }
  if (!allowed.has(setting)) throw invalid();
  return ["--backend", setting];
}

/** Backend flags from PI_RESEARCH_KETCH_BACKEND; empty when unset. */
export function configuredKetchBackendArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return ketchBackendArgs(env.PI_RESEARCH_KETCH_BACKEND);
}

/** Validate an operator Ketch config path without reading its contents. */
export async function resolveKetchConfig(value: string | undefined): Promise<string | undefined> {
  if (value === undefined || value.trim() === "") return undefined;
  const invalid = (cause?: unknown) => new KetchError(
    "PI_RESEARCH_KETCH_CONFIG must be an absolute path to a readable Ketch config file.",
    { code: "INVALID_KETCH_CONFIG", cause },
  );
  if (!isAbsolute(value)) throw invalid();
  try {
    if (!(await stat(value)).isFile()) throw invalid();
    await access(value, fsConstants.R_OK);
  } catch (cause) {
    if (cause instanceof KetchError) throw cause;
    throw invalid(cause);
  }
  return value;
}

function privateEnvironment(runtimeDir: string, explicit?: NodeJS.ProcessEnv, ketchConfig?: string): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  const names = ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM"];
  // Windows CreateProcess can require these variables even when no user
  // configuration is inherited. They are runtime plumbing, not credentials.
  if (process.platform === "win32") {
    names.push("SystemRoot", "WINDIR", "ComSpec", "PATHEXT");
  }
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) inherited[name] = value;
  }
  return {
    ...inherited,
    ...explicit,
    HOME: runtimeDir,
    USERPROFILE: runtimeDir,
    XDG_CONFIG_HOME: join(runtimeDir, "config"),
    XDG_CACHE_HOME: join(runtimeDir, "cache"),
    ...(ketchConfig ? { KETCH_CONFIG: ketchConfig } : {}),
    ...(process.platform === "win32"
      ? {
          APPDATA: join(runtimeDir, "AppData", "Roaming"),
          LOCALAPPDATA: join(runtimeDir, "AppData", "Local"),
        }
      : {}),
  };
}

function tryKill(child: SpawnLike, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    // Node can reject a signal on Windows or if the process exited in the
    // cancellation race. The close event remains the source of truth.
    return false;
  }
}

function killProcessTree(child: SpawnLike, signal: NodeJS.Signals): boolean {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // The process may have exited between close/error and cleanup.
    }
  }
  // Windows has no portable Node process-group equivalent. Kill the direct
  // child and do not claim that arbitrary descendants were terminated.
  return tryKill(child, signal);
}

export async function runKetch(
  args: readonly string[],
  options: KetchRunOptions = {},
): Promise<KetchRunResult> {
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const maxOutputBytes = boundedOutputBytes(options.maxOutputBytes);
  const maxRecords = options.maxRecords === undefined
    ? undefined
    : boundedInteger(options.maxRecords, 1, 1, MAX_CRAWL_PAGES, "maxRecords");
  const resolved = resolveKetchCommand(options.binary);
  const fullArgs = [...resolved.prefixArgs, ...args];

  if (options.signal?.aborted) throw new KetchCancelledError();
  const ketchConfig = await resolveKetchConfig(options.ketchConfig ?? process.env.PI_RESEARCH_KETCH_CONFIG);

  const runtimeDir = await mkdtemp(join(tmpdir(), "pi-ketch-"));
  try {
    return await new Promise<KetchRunResult>((resolve, reject) => {
      let child: SpawnLike;
      try {
        child = spawn(resolved.command, fullArgs, {
          cwd: options.cwd,
          env: privateEnvironment(runtimeDir, options.env, ketchConfig),
          detached: process.platform !== "win32",
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        }) as unknown as SpawnLike;
      } catch (cause) {
        reject(new KetchError(`Could not start ketch: ${String(cause)}`, { cause }));
        return;
      }

      let stdout = "";
      let stderr = "";
      let pendingLine = "";
      let recordCount = 0;
      let outputBytes = 0;
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let outputLimit = false;
      let limited = false;
      let stopRequested = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let killId: ReturnType<typeof setTimeout> | undefined;
      let progressId: ReturnType<typeof setInterval> | undefined;
      const startedAt = Date.now();

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (killId) clearTimeout(killId);
        if (progressId) clearInterval(progressId);
        options.signal?.removeEventListener("abort", onAbort);
        // Runtime cleanup is awaited in the outer finally block.
      };
      const stop = (reason: "timeout" | "cancel" | "output" | "records") => {
        if (stopRequested) return;
        stopRequested = true;
        if (reason === "timeout") timedOut = true;
        if (reason === "cancel") cancelled = true;
        if (reason === "records") limited = true;
        killProcessTree(child, "SIGTERM");
        killId = setTimeout(() => killProcessTree(child, "SIGKILL"), 250);
      };
      const onAbort = () => stop("cancel");
      const append = (kind: "stdout" | "stderr", chunk: unknown) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        outputBytes += Buffer.byteLength(text, "utf8");
        if (outputBytes > maxOutputBytes) {
          outputLimit = true;
          stop("output");
          return;
        }
        if (kind === "stderr") {
          stderr += text;
          return;
        }
        if (maxRecords === undefined) {
          stdout += text;
          return;
        }
        const lines = `${pendingLine}${text}`.split("\n");
        pendingLine = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) {
            try {
              JSON.parse(line);
              if (recordCount >= maxRecords) {
                stop("records");
                return;
              }
              recordCount += 1;
            } catch {
              // Preserve malformed lines; the strict adapter will return no results.
            }
          }
          stdout += `${line}\n`;
          if (recordCount >= maxRecords) { stop("records"); return; }
        }
      };

      child.stdout?.on("data", (chunk: unknown) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: unknown) => append("stderr", chunk));
      child.once("error", (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new KetchError(`Could not start ketch: ${String(error)}`, { cause: error }));
      });
      child.once("close", (code: unknown) => {
        if (settled) return;
        settled = true;
        if (maxRecords !== undefined && pendingLine.trim() && !limited) stdout += pendingLine;
        cleanup();
        const exitCode = typeof code === "number" ? code : 1;
        if (cancelled) {
          reject(new KetchCancelledError(undefined, { stderr }));
        } else if (timedOut) {
          reject(new KetchTimeoutError(timeoutMs, { stderr }));
        } else if (outputLimit) {
          reject(new KetchError(`ketch output exceeded ${maxOutputBytes} bytes.`, {
            code: "KETCH_OUTPUT_LIMIT",
            stderr,
          }));
        } else if (!limited && exitCode !== 0) {
          reject(new KetchCommandError(exitCode, stderr));
        } else {
          resolve({
            command: resolved.command,
            args: fullArgs,
            stdout,
            stderr,
            code: limited ? 0 : exitCode,
            parsed: parseJsonOutput(stdout),
            limited: limited || undefined,
          });
        }
      });

      options.signal?.addEventListener("abort", onAbort, { once: true });
      options.progress?.(`ketch ${args[0] ?? "command"} started`);
      progressId = options.progress
        ? setInterval(() => options.progress?.(`ketch ${args[0] ?? "command"} still running (${Math.floor((Date.now() - startedAt) / 1000)}s)`), 15_000)
        : undefined;
      timeoutId = setTimeout(() => stop("timeout"), timeoutMs);
      if (options.signal?.aborted) onAbort();
    });
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

export interface EvidenceItem {
  url: string;
  title?: string;
  snippet?: string;
  content?: string;
  source?: string;
  [key: string]: unknown;
}

export interface SearchEvidenceOptions {
  signal?: AbortSignal;
  limit?: number;
  backend?: string;
  timeoutMs?: number;
  binary?: string;
  ketchConfig?: string;
}

export interface FetchEvidenceOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  binary?: string;
  ketchConfig?: string;
  maxChars?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key] as string;
  }
  return undefined;
}

function arrayFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return [];
  for (const key of [
    "results", "items", "pages", "data", "matches", "organic_results",
    "organic", "searchResults", "documents", "hits", "webPages", "entries",
    "articles", "value",
  ]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
    const nested = asRecord(record[key]);
    if (nested) {
      const nestedItems = arrayFromPayload(nested);
      if (nestedItems.length > 0) return nestedItems;
    }
  }
  return [payload];
}

function strictEvidence(value: unknown, source?: string): EvidenceItem | null {
  const record = asRecord(value);
  if (!record || typeof record.url !== "string" || !record.url.trim()) return null;
  try { const url = new URL(record.url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null; } catch { return null; }
  for (const key of ["title", "snippet", "description", "content", "markdown", "source"]) {
    if (record[key] !== undefined && typeof record[key] !== "string") return null;
  }
  return {
    ...record,
    url: record.url,
    title: record.title as string | undefined,
    snippet: (record.snippet ?? record.description) as string | undefined,
    content: (record.content ?? record.markdown) as string | undefined,
    source: source ?? record.source as string | undefined,
  };
}

export function parseSearchEvidence(payload: unknown): EvidenceItem[] {
  const rows = Array.isArray(payload) ? payload : asRecord(payload)?.results;
  if (!Array.isArray(rows)) throw new KetchError("Unrecognized search response schema.", { code: "KETCH_SCHEMA_DRIFT" });
  const results = rows.map(item => strictEvidence(item, "ketch"));
  if (!results.every((item): item is EvidenceItem => item !== null)) throw new KetchError("Invalid search evidence schema.", { code: "KETCH_SCHEMA_DRIFT" });
  return results;
}

export function parseScrapeEvidence(payload: unknown): EvidenceItem {
  const item = strictEvidence(payload);
  if (!item || typeof item.content !== "string") throw new KetchError("Unrecognized scrape response schema.", { code: "KETCH_SCHEMA_DRIFT" });
  return item;
}

export async function searchEvidence(
  query: string,
  options: SearchEvidenceOptions = {},
): Promise<{ query: string; results: EvidenceItem[]; raw: unknown }> {
  if (!query.trim()) throw new KetchError("Search query is required.", { code: "INVALID_QUERY" });
  const limit = boundedInteger(options.limit, 5, 1, 50, "limit");
  const args = ["search", "--limit", String(limit), "--json"];
  if (options.backend) args.push("--backend", options.backend);
  else args.push(...configuredKetchBackendArgs());
  args.push("--", query);
  const result = await runKetch(args, options);
  const results = parseSearchEvidence(result.parsed);
  return {
    query,
    results: results.slice(0, limit),
    raw: result.parsed ?? result.stdout,
  };
}

export async function fetchEvidence(
  url: string,
  options: FetchEvidenceOptions = {},
): Promise<{ url: string; title?: string; content: string; raw: unknown }> {
  const normalizedUrl = validateHttpUrl(url);
  const args = ["scrape", "--json"];
  if (options.maxChars !== undefined) {
    args.push("--max-chars", String(boundedInteger(options.maxChars, 0, 1, 2_000_000, "maxChars")));
  }
  args.push("--", normalizedUrl);
  const result = await runKetch(args, options);
  const item = parseScrapeEvidence(result.parsed);
  return {
    url: normalizedUrl,
    title: item?.title,
    content: item?.content ?? "",
    raw: result.parsed ?? result.stdout,
  };
}

export class KetchClient {
  private readonly defaults: KetchRunOptions;

  constructor(defaults: KetchRunOptions = {}) {
    this.defaults = defaults;
  }

  run(args: readonly string[], options: KetchRunOptions = {}): Promise<KetchRunResult> {
    return runKetch(args, { ...this.defaults, ...options });
  }

  searchEvidence(query: string, options: SearchEvidenceOptions = {}) {
    return searchEvidence(query, { ...this.defaults, ...options });
  }

  fetchEvidence(url: string, options: FetchEvidenceOptions = {}) {
    return fetchEvidence(url, { ...this.defaults, ...options });
  }
}

export function createKetchClient(options: KetchRunOptions = {}): KetchClient {
  return new KetchClient(options);
}
