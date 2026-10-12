import type { SearchOptions, SourceAdapter, SourceErrorCode } from "./types.ts";
import { createSocialSourceAdapters, type SocialSourceAdapterOptions } from "./social-sources.ts";

/** The public endpoints used here are deliberately fixed; callers cannot supply a host or redirect target. */
export const HACKER_NEWS_SEARCH_ENDPOINT = "https://hn.algolia.com/api/v1/search_by_date";
export const GITHUB_REPOSITORY_SEARCH_ENDPOINT = "https://api.github.com/search/repositories";
export const SOURCE_TIMEOUT_MS = 15_000;
export const SOURCE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const SOURCE_MAX_RESULTS = 50;

const APPROVED_SOURCE_HOSTS = new Set([
  "api.github.com",
  "hn.algolia.com",
  "www.reddit.com",
  "gamma-api.polymarket.com",
  "api.x.com",
  "www.googleapis.com",
  "bsky.social",
]);

export type SourceFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SourceAdapterOptions {
  fetch?: SourceFetch;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export class SourceAdapterError extends Error {
  readonly code: SourceErrorCode;
  readonly httpStatus?: number;

  constructor(message: string, code: SourceErrorCode, options: { httpStatus?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "SourceAdapterError";
    this.code = code;
    this.httpStatus = options.httpStatus;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeUrl(value: unknown): string | undefined {
  const input = text(value);
  if (!input) return undefined;
  try {
    const url = new URL(input);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname) return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function isoDate(value: unknown): string | undefined {
  const input = typeof value === "string" || typeof value === "number" ? value : undefined;
  if (input === undefined) return undefined;
  const date = new Date(input);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function windowDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function resultLimit(options?: SearchOptions): number {
  const value = options?.limit;
  return Number.isInteger(value) && value && value > 0 ? Math.min(value, SOURCE_MAX_RESULTS) : SOURCE_MAX_RESULTS;
}

async function responseText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const value = await response.text();
    if (Buffer.byteLength(value, "utf8") > maxBytes) throw new SourceAdapterError("Source response exceeded the output limit.", "output_limit");
    return value;
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new SourceAdapterError("Source response exceeded the output limit.", "output_limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function fetchSourceJson(
  endpoint: string,
  init: RequestInit,
  options: SourceAdapterOptions & SearchOptions = {},
): Promise<unknown> {
  const expected = new URL(endpoint);
  if (expected.protocol !== "https:" || !APPROVED_SOURCE_HOSTS.has(expected.hostname)) {
    throw new SourceAdapterError("Source endpoint is not an approved HTTPS endpoint.", "network");
  }
  const fetcher = options.fetch ?? fetch;
  if (options.signal?.aborted) throw options.signal.reason ?? new SourceAdapterError("Source request cancelled.", "cancelled");
  const controller = new AbortController();
  const timeoutMs = Number.isInteger(options.timeoutMs) && (options.timeoutMs as number) > 0 ? Math.min(options.timeoutMs as number, 120_000) : SOURCE_TIMEOUT_MS;
  const maxOutputBytes = Number.isInteger(options.maxOutputBytes) && (options.maxOutputBytes as number) > 0 ? Math.min(options.maxOutputBytes as number, SOURCE_MAX_OUTPUT_BYTES) : SOURCE_MAX_OUTPUT_BYTES;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetcher(endpoint, { ...init, signal: controller.signal, redirect: "error" });
    // redirect:error is the primary guard. This also rejects a custom fetcher's
    // silently followed redirect when it reports a different origin/path.
    if (response.url && (new URL(response.url).origin !== expected.origin || new URL(response.url).pathname !== expected.pathname)) {
      throw new SourceAdapterError("Source response redirected to an unapproved URL.", "network");
    }
    if (!response.ok) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      const message = `Source HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`;
      if (response.status === 429 || remaining === "0") throw new SourceAdapterError(message, "rate_limited", { httpStatus: response.status });
      if (response.status === 401) throw new SourceAdapterError(message, "auth_required", { httpStatus: response.status });
      if (response.status === 403) throw new SourceAdapterError(message, "access_denied", { httpStatus: response.status });
      throw new SourceAdapterError(message, "network", { httpStatus: response.status });
    }
    const body = await responseText(response, maxOutputBytes);
    try {
      return JSON.parse(body) as unknown;
    } catch (cause) {
      throw new SourceAdapterError("Source returned invalid JSON.", "schema", { cause });
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timedOut) throw new SourceAdapterError(`Source request timed out after ${timeoutMs}ms.`, "timeout", { cause: error });
    if (error instanceof SourceAdapterError) throw error;
    throw new SourceAdapterError("Source request failed.", "network", { cause: error });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

function hnSearchUrl(query: string, options?: SearchOptions): string {
  const url = new URL(HACKER_NEWS_SEARCH_ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("tags", "story");
  url.searchParams.set("hitsPerPage", String(resultLimit(options)));
  const after = windowDate(options?.after);
  const before = windowDate(options?.before);
  if (after) url.searchParams.append("numericFilters", `created_at_i>=${Math.floor(after.getTime() / 1000)}`);
  if (before) url.searchParams.append("numericFilters", `created_at_i<${Math.floor(before.getTime() / 1000)}`);
  return url.toString();
}

function githubSearchUrl(query: string, options?: SearchOptions): string {
  const url = new URL(GITHUB_REPOSITORY_SEARCH_ENDPOINT);
  const terms = [query];
  const after = windowDate(options?.after);
  const before = windowDate(options?.before);
  if (after) terms.push(`updated:>=${after.toISOString().slice(0, 10)}`);
  if (before) terms.push(`updated:<=${before.toISOString().slice(0, 10)}`);
  url.searchParams.set("q", terms.join(" "));
  url.searchParams.set("sort", "updated");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(resultLimit(options)));
  return url.toString();
}

function normalizeHackerNews(value: unknown): unknown[] {
  const payload = record(value);
  if (!payload || !Array.isArray(payload.hits)) throw new SourceAdapterError("Hacker News returned an unknown response schema.", "schema");
  const items: unknown[] = [];
  for (const raw of payload.hits) {
    const hit = record(raw);
    if (!hit || !text(hit.objectID) || !isoDate(hit.created_at)) continue;
    const id = text(hit.objectID) as string;
    const url = safeUrl(hit.url) ?? safeUrl(hit.story_url) ?? `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}`;
    if (!url) continue;
    const title = text(hit.title) ?? text(hit.story_title) ?? "Untitled Hacker News story";
    const comments = finiteNumber(hit.num_comments);
    const score = finiteNumber(hit.points);
    items.push({
      title,
      url,
      snippet: text(hit.story_text) ?? text(hit.comment_text) ?? `Hacker News story with ${comments ?? 0} comments.`,
      publishedAt: isoDate(hit.created_at),
      dateKind: "submission",
      ...(text(hit.author) ? { author: text(hit.author) } : {}),
      ...((score !== undefined || comments !== undefined) ? { engagement: { ...(score !== undefined ? { score } : {}), ...(comments !== undefined ? { comments } : {}) } } : {}),
    });
  }
  if (payload.hits.length > 0 && items.length === 0) throw new SourceAdapterError("Hacker News returned no records matching its documented schema.", "schema");
  return items;
}

function normalizeGitHub(value: unknown): unknown[] {
  const payload = record(value);
  if (!payload || !Array.isArray(payload.items) || typeof payload.total_count !== "number") throw new SourceAdapterError("GitHub returned an unknown response schema.", "schema");
  const items: unknown[] = [];
  for (const raw of payload.items) {
    const repo = record(raw);
    if (!repo) continue;
    const name = text(repo.full_name);
    const url = safeUrl(repo.html_url);
    const updatedAt = isoDate(repo.updated_at);
    if (!name || !url || !updatedAt) continue;
    const stars = finiteNumber(repo.stargazers_count);
    const forks = finiteNumber(repo.forks_count);
    items.push({
      title: name,
      url,
      snippet: `${text(repo.description) ?? `Public GitHub repository ${name}.`} Repository updated at ${updatedAt}; this is not an article publication date.`,
      publishedAt: updatedAt,
      dateKind: "repository-update",
      ...(record(repo.owner) && text(record(repo.owner)?.login) ? { author: text(record(repo.owner)?.login) } : {}),
      ...((stars !== undefined || forks !== undefined) ? { engagement: { ...(stars !== undefined ? { stars } : {}), ...(forks !== undefined ? { forks } : {}) } } : {}),
    });
  }
  if (payload.items.length > 0 && items.length === 0) throw new SourceAdapterError("GitHub returned no records matching its documented schema.", "schema");
  return items;
}

export function createHackerNewsAdapter(options: SourceAdapterOptions = {}): SourceAdapter {
  return {
    id: "hacker-news",
    label: "Hacker News (Algolia public search)",
    capabilities: ["search"],
    async search(query, searchOptions = {}) {
      return normalizeHackerNews(await fetchSourceJson(hnSearchUrl(query, searchOptions), { headers: { accept: "application/json" } }, { ...options, ...searchOptions }));
    },
  };
}

export function createGitHubAdapter(options: SourceAdapterOptions = {}): SourceAdapter {
  return {
    id: "github",
    label: "GitHub (public repository search)",
    capabilities: ["search"],
    async search(query, searchOptions = {}) {
      // Deliberately omit Authorization and never read GITHUB_TOKEN: this is a
      // keyless public API adapter and must not inherit ambient credentials.
      return normalizeGitHub(await fetchSourceJson(githubSearchUrl(query, searchOptions), {
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "research-pi-research-kit" },
      }, { ...options, ...searchOptions }));
    },
  };
}

export function createDefaultSourceAdapters(options: SourceAdapterOptions & SocialSourceAdapterOptions = {}): readonly SourceAdapter[] {
  return [createHackerNewsAdapter(options), createGitHubAdapter(options), ...createSocialSourceAdapters(options)];
}

export function createDefaultSourceRegistry(options: SourceAdapterOptions & SocialSourceAdapterOptions = {}): ResearchSourceRegistry {
  return createSourceRegistry(createDefaultSourceAdapters(options));
}

export class ResearchSourceRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): void {
    if (!adapter.id.trim() || !adapter.label.trim()) throw new Error("A source adapter requires an id and label.");
    if (!adapter.search && !adapter.fetch) throw new Error(`Source adapter ${adapter.id} exposes no capabilities.`);
    if (this.adapters.has(adapter.id)) throw new Error(`Source adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): SourceAdapter | undefined { return this.adapters.get(id); }
  list(): readonly SourceAdapter[] { return [...this.adapters.values()].sort((a, b) => a.id.localeCompare(b.id)); }
}

export function createSourceRegistry(adapters: readonly SourceAdapter[] = []): ResearchSourceRegistry {
  const registry = new ResearchSourceRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}

export function registerSourceAdapter(registry: ResearchSourceRegistry, adapter: SourceAdapter): ResearchSourceRegistry {
  registry.register(adapter);
  return registry;
}
