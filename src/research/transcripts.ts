import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SourceAdapter } from "./types.ts";
import { SOURCE_MAX_OUTPUT_BYTES, SourceAdapterError, type SourceAdapterOptions } from "./sources.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSCRIPT_BYTES = 1_000_000;
const DEFAULT_LANGUAGES = ["en.*", "en"];
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export interface TranscriptFetcherOptions extends SourceAdapterOptions {
  /** Explicit path/name supplied by the operator. No installer or environment lookup is performed. */
  executable?: string;
  /** Optional subtitle language fallback chain, passed to yt-dlp as --sub-langs. */
  languages?: readonly string[];
  /** Extra argv prefix for an explicit executable, useful for a JS helper via process.execPath in tests. */
  executableArgs?: readonly string[];
  maxTranscriptBytes?: number;
}

export interface TranscriptSegment {
  startSeconds: number;
  text: string;
}

export interface TranscriptFetchResult {
  title: string;
  url: string;
  content: string;
  transcript: string;
  segments: TranscriptSegment[];
  publishedAt: string | null;
  dateKind?: "upload-date" | "release-date";
  language?: string;
  transcriptStatus: "available" | "unavailable";
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function videoId(value: string): string | undefined {
  const input = value.trim();
  if (VIDEO_ID.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(url.hostname)) return undefined;
    if (url.hostname === "youtu.be") return VIDEO_ID.test(url.pathname.slice(1)) ? url.pathname.slice(1) : undefined;
    const query = url.searchParams.get("v");
    if (query && VIDEO_ID.test(query)) return query;
    return url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/)?.[1];
  } catch {
    return undefined;
  }
}

function canonicalVideoUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isInteger(value) && value && value > 0 ? Math.min(value, maximum) : fallback;
}

function safeLanguageList(languages: readonly string[] | undefined): string | undefined {
  if (!languages) return undefined;
  const valid = languages.filter((language) => /^[A-Za-z0-9.*_-]+$/.test(language));
  return valid.length ? valid.join(",") : undefined;
}

function appendBounded(target: { value: string; bytes: number }, chunk: Buffer, maxBytes: number): void {
  target.bytes += chunk.byteLength;
  if (target.bytes > maxBytes) throw new SourceAdapterError("yt-dlp output exceeded the bounded output limit.", "output_limit");
  target.value += chunk.toString("utf8");
}

const TERMINATION_GRACE_MS = 250;
const TREE_WATCHDOG_MS = 2_000;

class TranscriptProcessError extends SourceAdapterError {
  readonly treeTerminated: boolean;

  constructor(message: string, code: ConstructorParameters<typeof SourceAdapterError>[1], treeTerminated: boolean) {
    super(message, code);
    this.treeTerminated = treeTerminated;
  }
}

function processError(error: unknown, treeTerminated: boolean): TranscriptProcessError {
  const message = error instanceof SourceAdapterError ? error.message : "Transcript helper failed.";
  const code = error instanceof SourceAdapterError ? error.code : "network";
  return new TranscriptProcessError(treeTerminated ? message : `${message} Process-group termination was not established; the private workspace was retained.`, code, treeTerminated);
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive(pgid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  return !groupAlive(pgid);
}

async function runYtDlp(executable: string, executableArgs: readonly string[], args: readonly string[], cwd: string, options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal }): Promise<{ stdout: string }> {
  return await new Promise((resolve, reject) => {
    // Do not inherit the caller's environment: in particular this prevents
    // cookies, proxy credentials, and configuration paths from being passed to yt-dlp.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      XDG_CONFIG_HOME: cwd,
      XDG_CACHE_HOME: cwd,
      LANG: "C",
      LC_ALL: "C",
    };
    if (process.platform === "win32") {
      // These are runtime necessities for Windows process lookup, not user credentials.
      env.SystemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
      env.WINDIR = process.env.WINDIR;
      env.PATHEXT = process.env.PATHEXT;
      env.ComSpec = process.env.ComSpec;
    }
    const child = spawn(executable, [...executableArgs, ...args], { cwd, env, shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const pgid = child.pid;
    const stop = (signal: "SIGTERM" | "SIGKILL"): void => {
      if (pgid && process.platform !== "win32") {
        try { process.kill(-pgid, signal); } catch { /* the process group may already have exited */ }
      }
      try { child.kill(signal); } catch { /* the process may already have exited */ }
    };
    const stdout = { value: "", bytes: 0 };
    const stderr = { value: "", bytes: 0 };
    let settled = false;
    let stopping = false;
    let pendingError: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      options.signal?.removeEventListener("abort", abort);
      if (error === undefined) resolve({ stdout: stdout.value });
      else reject(error);
    };
    const requestStop = (error: unknown): void => {
      if (pendingError === undefined) pendingError = error;
      if (stopping) return;
      stopping = true;
      stop("SIGTERM");
      killTimer = setTimeout(() => stop("SIGKILL"), TERMINATION_GRACE_MS);
      // close may wait on inherited pipes; never wait without a finite bound.
      watchdogTimer = setTimeout(() => {
        stop("SIGKILL");
        settle(processError(pendingError ?? new SourceAdapterError("Transcript helper stopped.", "cancelled"), false));
      }, TREE_WATCHDOG_MS);
    };
    const abort = (): void => requestStop(new SourceAdapterError("Transcript request cancelled.", "cancelled"));
    options.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => requestStop(new SourceAdapterError(`yt-dlp timed out after ${options.timeoutMs}ms.`, "timeout")), options.timeoutMs);
    // Cover an abort racing with listener registration and process startup.
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      try { appendBounded(stdout, chunk, options.maxOutputBytes); }
      catch (error) { requestStop(error); }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      try { appendBounded(stderr, chunk, options.maxOutputBytes); }
      catch (error) { requestStop(error); }
    });
    child.once("error", (error) => requestStop(new SourceAdapterError("Configured yt-dlp executable could not be run.", "network", { cause: error })));
    child.once("close", async (code) => {
      if (pendingError !== undefined) {
        if (watchdogTimer) clearTimeout(watchdogTimer);
        if (killTimer) clearTimeout(killTimer);
        if (stopping && process.platform !== "win32" && pgid) {
          stop("SIGKILL");
          const treeTerminated = await waitForGroupExit(pgid, TREE_WATCHDOG_MS);
          settle(processError(pendingError, treeTerminated));
        } else settle(processError(pendingError, false));
        return;
      }
      if (code !== 0) {
        // Never attach stderr: helper output can contain URLs, titles, or other sensitive data.
        const failure = new SourceAdapterError("yt-dlp did not return a transcript; subtitles may be unavailable or disabled.", "access_denied");
        if (process.platform !== "win32" && pgid) {
          stop("SIGKILL");
          const treeTerminated = await waitForGroupExit(pgid, TREE_WATCHDOG_MS);
          settle(processError(failure, treeTerminated));
        } else settle(failure);
        return;
      }
      settle();
    });
  });
}

function parseTimestamp(value: string): number | undefined {
  const match = value.trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return undefined;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  return Number.isFinite(hours + minutes + seconds + milliseconds) ? hours * 3600 + minutes * 60 + seconds + milliseconds / 1000 : undefined;
}

function cleanCaption(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

function parseCaptions(value: string): TranscriptSegment[] {
  const lines = value.replace(/^\uFEFF/, "").split(/\r?\n/);
  const segments: TranscriptSegment[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^\s*(\S+)\s+-->\s+(\S+)/);
    if (!match) continue;
    const start = parseTimestamp(match[1] ?? "");
    if (start === undefined) continue;
    const caption: string[] = [];
    for (index += 1; index < lines.length && lines[index]?.trim(); index += 1) caption.push(lines[index] ?? "");
    const captionText = cleanCaption(caption.join(" "));
    if (captionText && segments[segments.length - 1]?.text !== captionText) segments.push({ startSeconds: start, text: captionText });
  }
  return segments;
}

function metadata(stdout: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function metadataDate(value: Record<string, unknown> | undefined): { value: string; kind: "upload-date" | "release-date" } | undefined {
  const timestamp = value?.release_timestamp ?? value?.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    const date = new Date(timestamp * 1000);
    if (Number.isFinite(date.getTime())) return { value: date.toISOString(), kind: "release-date" };
  }
  const upload = text(value?.upload_date);
  if (upload && /^\d{8}$/.test(upload)) {
    const date = new Date(`${upload.slice(0, 4)}-${upload.slice(4, 6)}-${upload.slice(6, 8)}T00:00:00.000Z`);
    if (Number.isFinite(date.getTime())) return { value: date.toISOString(), kind: "upload-date" };
  }
  return undefined;
}

const MAX_TRANSCRIPT_FILES = 16;

async function readTranscriptFiles(directory: string, maxBytes: number): Promise<{ text: string; segments: TranscriptSegment[]; language?: string }> {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => /\.(?:vtt|srt)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (files.length > MAX_TRANSCRIPT_FILES) throw new SourceAdapterError("Too many transcript files were produced.", "output_limit");
  let declaredBytes = 0;
  const sizes = new Map<string, number>();
  for (const file of files) {
    const path = join(directory, file);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new SourceAdapterError("Transcript subtitle files must be private regular files.", "schema");
    if (stat.size > maxBytes - declaredBytes) throw new SourceAdapterError("Transcript file exceeded the bounded output limit.", "output_limit");
    declaredBytes += stat.size;
    sizes.set(file, stat.size);
  }
  let totalBytes = 0;
  for (const file of files) {
    const raw = await readFile(join(directory, file));
    totalBytes += raw.byteLength;
    if (raw.byteLength !== sizes.get(file) || totalBytes > maxBytes) throw new SourceAdapterError("Transcript file changed during bounded read.", "output_limit");
    const segments = parseCaptions(raw.toString("utf8"));
    if (!segments.length) continue;
    return { text: segments.map((segment) => segment.text).join(" "), segments, language: file.split(".").at(-2) };
  }
  return { text: "", segments: [] };
}

export function createTranscriptFetcher(options: TranscriptFetcherOptions = {}): SourceAdapter {
  return {
    id: "youtube-transcript",
    label: "YouTube transcripts (operator-configured yt-dlp)",
    capabilities: ["fetch"],
    async fetch(inputUrl: string, fetchOptions: { signal?: AbortSignal } = {}) {
      const id = videoId(inputUrl);
      const executable = options.executable?.trim();
      if (!id) throw new SourceAdapterError("Transcript fetch requires a canonical HTTPS YouTube URL or 11-character video ID.", "schema");
      if (!executable) throw new SourceAdapterError("YouTube transcripts are disabled; configure an explicit yt-dlp executable.", "auth_required");
      if (!isAbsolute(executable)) throw new SourceAdapterError("The yt-dlp executable must be an explicit absolute path.", "schema");
      if (process.platform === "win32") throw new SourceAdapterError("YouTube transcripts are disabled on Windows until process-tree termination is supported.", "access_denied");
      const timeoutMs = bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, 120_000);
      const maxOutputBytes = bounded(options.maxOutputBytes, SOURCE_MAX_OUTPUT_BYTES, SOURCE_MAX_OUTPUT_BYTES);
      const maxTranscriptBytes = bounded(options.maxTranscriptBytes, DEFAULT_TRANSCRIPT_BYTES, SOURCE_MAX_OUTPUT_BYTES);
      const directory = await mkdtemp(join(tmpdir(), "pi-research-transcript-"));
      const canonicalUrl = canonicalVideoUrl(id);
      const outputTemplate = join(directory, "%(id)s.%(ext)s");
      const args = [
        "--ignore-config",
        "--no-cache-dir",
        "--no-playlist",
        "--skip-download",
        "--no-simulate",
        "--write-subs",
        "--write-auto-subs",
        "--sub-format", "vtt",
        ...(safeLanguageList(options.languages ?? DEFAULT_LANGUAGES) ? ["--sub-langs", safeLanguageList(options.languages ?? DEFAULT_LANGUAGES) as string] : []),
        "--dump-single-json",
        "--output", outputTemplate,
        canonicalUrl,
      ];
      let retainWorkspace = false;
      try {
        const result = await runYtDlp(executable, options.executableArgs ?? [], args, directory, { timeoutMs, maxOutputBytes, signal: fetchOptions.signal });
        const files = await readTranscriptFiles(directory, maxTranscriptBytes);
        if (!files.text) throw new SourceAdapterError("Transcript unavailable or disabled: yt-dlp returned no usable subtitle file.", "access_denied");
        const info = metadata(result.stdout);
        const dated = metadataDate(info);
        return {
          title: text(info?.title) ?? `Transcript for ${canonicalUrl}`,
          url: canonicalUrl,
          content: files.text,
          transcript: files.text,
          segments: files.segments,
          publishedAt: dated?.value ?? null,
          ...(dated ? { dateKind: dated.kind } : {}),
          ...(files.language ? { language: files.language } : {}),
          transcriptStatus: "available",
        } satisfies TranscriptFetchResult;
      } catch (error) {
        retainWorkspace = error instanceof TranscriptProcessError && !error.treeTerminated;
        throw error;
      } finally {
        if (!retainWorkspace) await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

export const createYouTubeTranscriptFetcher = createTranscriptFetcher;
export type TranscriptSourceAdapterOptions = TranscriptFetcherOptions;
