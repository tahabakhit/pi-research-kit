import type { AgentToolUpdateCallback, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  boundedInteger,
  configuredKetchBackendArgs,
  fetchEvidence,
  KetchClient,
  KetchError,
  MAX_CRAWL_DEPTH,
  MAX_CRAWL_PAGES,
  MAX_RESULT_BYTES,
  MAX_RESULT_LINES,
  MAX_URLS,
  runKetch,
  searchEvidence,
  validateHttpUrl,
  type KetchRunOptions,
} from "../ketch/client.ts";

const MAX_LIMIT = 50;

type AnyTool = ToolDefinition<any, any, any>;

export interface KetchToolDeps extends KetchRunOptions {
  client?: KetchClient;
}

function jsonText(value: unknown): { text: string; truncated: boolean } {
  const source = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const lines = source.split("\n");
  let text = "";
  for (const line of lines.slice(0, MAX_RESULT_LINES)) {
    const next = text ? `${text}\n${line}` : line;
    if (Buffer.byteLength(next, "utf8") > MAX_RESULT_BYTES) break;
    text = next;
  }
  const truncated = text.length < source.length || lines.length > MAX_RESULT_LINES;
  return {
    text: truncated ? `${text}\n\n[output truncated to ${MAX_RESULT_BYTES} bytes/${MAX_RESULT_LINES} lines]` : text,
    truncated,
  };
}

function result(payload: unknown, details: Record<string, unknown> = {}) {
  const bounded = jsonText(payload);
  return {
    content: [{ type: "text" as const, text: bounded.text }],
    details: { ...details, truncated: bounded.truncated },
  };
}

function stringArray(values: string[] | undefined, name: string, max: number): string[] {
  if (!values) return [];
  if (values.length > max) throw new KetchError(`${name} may contain at most ${max} items.`, { code: "INVALID_OPTION" });
  return values.map((value) => {
    if (!value.trim()) throw new KetchError(`${name} cannot contain empty values.`, { code: "INVALID_OPTION" });
    return value;
  });
}

function compatibilitySearchQuery(params: WebSearchParams): string {
  const quote = (value: string) => JSON.stringify(value);
  const exact = stringArray(params.exactPhrases, "exactPhrases", 20).map(quote);
  const excluded = stringArray(params.excludeTerms, "excludeTerms", 20).map((value) => `-${quote(value)}`);
  const site = params.site?.trim() ? [`site:${params.site.trim()}`] : [];
  return [params.query, ...exact, ...excluded, ...site].join(" ");
}

function optionArgs(options: { maxChars?: number; trim?: boolean; minimal?: boolean }): string[] {
  const args: string[] = [];
  if (options.maxChars !== undefined) {
    args.push("--max-chars", String(boundedInteger(options.maxChars, 0, 1, 2_000_000, "maxChars")));
  }
  if (options.trim) args.push("--trim");
  if (options.minimal) args.push("--minimal");
  return args;
}

function createRun(
  deps: KetchToolDeps,
  signal: AbortSignal | undefined,
  onUpdate?: AgentToolUpdateCallback<any>,
): KetchRunOptions {
  const { client: _client, ...runOptions } = deps;
  return {
    ...runOptions,
    signal,
    progress: onUpdate
      ? (message) => onUpdate({ content: [{ type: "text", text: message }], details: {} })
      : undefined,
  };
}

async function executeCommand(
  command: string,
  args: string[],
  deps: KetchToolDeps,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<any>,
  maxRecords?: number,
) {
  // Keep the global JSON flag before the separator. Everything after `--` is
  // one or more positional values and can never be parsed as a CLI flag.
  const run = await runKetch(
    [command, "--json", ...args],
    { ...createRun(deps, signal, onUpdate), maxRecords },
  );
  return result(run.parsed ?? run.stdout, {
    command: run.command,
    args: run.args,
    exitCode: run.code,
    hasWarnings: Boolean(run.stderr),
    limited: run.limited,
  });
}

const searchParameters = Type.Object({
  query: Type.String({ minLength: 1, description: "Web search query." }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
  backend: Type.Optional(Type.String()),
  scrape: Type.Optional(Type.Boolean()),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000_000 })),
  minimal: Type.Optional(Type.Boolean()),
  trim: Type.Optional(Type.Boolean()),
  multi: Type.Optional(Type.String()),
  random: Type.Optional(Type.String()),
});

const scrapeParameters = Type.Object({
  url: Type.Optional(Type.String({ description: "HTTP(S) URL to scrape." })),
  urls: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_URLS })),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000_000 })),
  raw: Type.Optional(Type.Boolean()),
  trim: Type.Optional(Type.Boolean()),
  noCache: Type.Optional(Type.Boolean()),
  forceBrowser: Type.Optional(Type.Boolean()),
  noLlmsTxt: Type.Optional(Type.Boolean()),
  select: Type.Optional(Type.String()),
});

const crawlParameters = Type.Object({
  url: Type.String({ minLength: 1 }),
  depth: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_CRAWL_DEPTH })),
  maxPages: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CRAWL_PAGES })),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  allow: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
  deny: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
  sitemap: Type.Optional(Type.Boolean()),
  noCache: Type.Optional(Type.Boolean()),
});

const codeParameters = Type.Object({
  query: Type.String({ minLength: 1 }),
  backend: Type.Optional(Type.String()),
  lang: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
  regex: Type.Optional(Type.Boolean()),
  minimal: Type.Optional(Type.Boolean()),
});

const docsParameters = Type.Object({
  query: Type.String({ minLength: 1 }),
  backend: Type.Optional(Type.String()),
  library: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
  resolve: Type.Optional(Type.Boolean()),
  tokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_000 })),
});

const webSearchParameters = Type.Object({
  query: Type.Optional(Type.String()),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
  exactPhrases: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
  excludeTerms: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
  site: Type.Optional(Type.String({ minLength: 1 })),
});

const webFetchParameters = Type.Object({
  url: Type.String({ minLength: 1 }),
});

type SearchParams = {
  query: string;
  limit?: number;
  backend?: string;
  scrape?: boolean;
  maxChars?: number;
  minimal?: boolean;
  trim?: boolean;
  multi?: string;
  random?: string;
};
type ScrapeParams = {
  url?: string;
  urls?: string[];
  concurrency?: number;
  maxChars?: number;
  raw?: boolean;
  trim?: boolean;
  noCache?: boolean;
  forceBrowser?: boolean;
  noLlmsTxt?: boolean;
  select?: string;
};
type CrawlParams = { url: string; depth?: number; concurrency?: number; allow?: string[]; deny?: string[]; sitemap?: boolean; noCache?: boolean; maxPages?: number };
type CodeParams = { query: string; backend?: string; lang?: string; limit?: number; regex?: boolean; minimal?: boolean };
type DocsParams = { query: string; backend?: string; library?: string; limit?: number; resolve?: boolean; tokens?: number };
type WebSearchParams = { query?: string; count?: number; exactPhrases?: string[]; excludeTerms?: string[]; site?: string };
type WebFetchParams = { url: string };

function makeTools(deps: KetchToolDeps): AnyTool[] {
  const searchTool: AnyTool = {
    name: "ketch_search",
    label: "Ketch Search",
    description: "Search the web with pinned ketch-cli 0.17.1. Returns bounded structured JSON.",
    parameters: searchParameters,
    async execute(_id: string, params: SearchParams, signal: AbortSignal, onUpdate?: AgentToolUpdateCallback<any>) {
      const args = ["--limit", String(boundedInteger(params.limit, 5, 1, MAX_LIMIT, "limit"))];
      if ([params.backend, params.multi, params.random].filter(Boolean).length > 1) throw new KetchError("backend, multi and random are mutually exclusive.");
      if (params.backend) args.push("--backend", params.backend);
      if (params.scrape) args.push("--scrape");
      if (params.multi) args.push(`--multi=${params.multi}`);
      if (params.random) args.push(`--random=${params.random}`);
      if (!params.backend && !params.multi && !params.random) args.push(...configuredKetchBackendArgs());
      args.push(...optionArgs(params), "--", params.query);
      return executeCommand("search", args, deps, signal, onUpdate);
    },
  };

  const scrapeTool: AnyTool = {
    name: "ketch_scrape",
    label: "Ketch Scrape",
    description: "Fetch HTTP(S) URLs with ketch-cli and extract bounded clean content.",
    parameters: scrapeParameters,
    async execute(_id: string, params: ScrapeParams, signal: AbortSignal, onUpdate?: AgentToolUpdateCallback<any>) {
      if (params.url && params.urls) throw new KetchError("Provide url or urls, not both.");
      const urls = params.urls ?? (params.url ? [params.url] : []);
      if (urls.length === 0) throw new KetchError("url or urls is required.", { code: "INVALID_URL" });
      const checked = stringArray(urls, "urls", MAX_URLS).map(validateHttpUrl);
      const args: string[] = [];
      if (params.concurrency !== undefined) args.push("--concurrency", String(params.concurrency));
      if (params.raw) args.push("--raw");
      if (params.noCache) args.push("--no-cache");
      if (params.forceBrowser) args.push("--force-browser");
      if (params.noLlmsTxt) args.push("--no-llms-txt");
      if (params.select) args.push("--select", params.select);
      args.push(...optionArgs(params), "--", ...checked);
      return executeCommand("scrape", args, deps, signal, onUpdate);
    },
  };

  const crawlTool: AnyTool = {
    name: "ketch_crawl",
    label: "Ketch Crawl",
    description: "Crawl an HTTP(S) site with bounded depth and concurrency.",
    parameters: crawlParameters,
    async execute(_id: string, params: CrawlParams, signal: AbortSignal, onUpdate?: AgentToolUpdateCallback<any>) {
      const args: string[] = [];
      if (params.depth !== undefined) args.push("--depth", String(params.depth));
      if (params.concurrency !== undefined) args.push("--concurrency", String(params.concurrency));
      for (const allow of stringArray(params.allow, "allow", 50)) args.push("--allow", allow);
      for (const deny of stringArray(params.deny, "deny", 50)) args.push("--deny", deny);
      if (params.sitemap) args.push("--sitemap");
      if (params.noCache) args.push("--no-cache");
      args.push("--", validateHttpUrl(params.url));
      const maxPages = boundedInteger(params.maxPages, MAX_CRAWL_PAGES, 1, MAX_CRAWL_PAGES, "maxPages");
      return executeCommand("crawl", args, deps, signal, onUpdate, maxPages);
    },
  };

  const codeTool: AnyTool = {
    name: "ketch_code",
    label: "Ketch Code Search",
    description: "Search public source code with ketch-cli.",
    parameters: codeParameters,
    async execute(_id: string, params: CodeParams, signal: AbortSignal, onUpdate?: AgentToolUpdateCallback<any>) {
      const args = ["--limit", String(boundedInteger(params.limit, 5, 1, MAX_LIMIT, "limit"))];
      if (params.backend) args.push("--backend", params.backend);
      if (params.lang) args.push("--lang", params.lang);
      if (params.regex) args.push("--regex");
      if (params.minimal) args.push("--minimal");
      args.push("--", params.query);
      return executeCommand("code", args, deps, signal, onUpdate);
    },
  };

  const docsTool: AnyTool = {
    name: "ketch_docs",
    label: "Ketch Docs",
    description: "Search library documentation with ketch-cli.",
    parameters: docsParameters,
    async execute(_id: string, params: DocsParams, signal: AbortSignal, onUpdate?: AgentToolUpdateCallback<any>) {
      const args = ["--limit", String(boundedInteger(params.limit, 5, 1, MAX_LIMIT, "limit"))];
      if (params.backend) args.push("--backend", params.backend);
      if (params.library) args.push("--library", params.library);
      if (params.resolve) args.push("--resolve");
      if (params.tokens !== undefined) args.push("--tokens", String(params.tokens));
      args.push("--", params.query);
      return executeCommand("docs", args, deps, signal, onUpdate);
    },
  };

  const webSearchTool: AnyTool = {
    name: "web_search",
    label: "Web Search (Ketch)",
    description: "Compatibility alias for ketch_search; searches the web without an MCP bridge.",
    parameters: webSearchParameters,
    async execute(_id: string, params: WebSearchParams, signal: AbortSignal) {
      const query = compatibilitySearchQuery(params);
      const found = deps.client
        ? await deps.client.searchEvidence(query, { signal, limit: params.count })
        : await searchEvidence(query, { ...deps, signal, limit: params.count });
      return result(found, { compatibility: "web_search", resultCount: found.results.length });
    },
  };

  const webFetchTool: AnyTool = {
    name: "web_fetch",
    label: "Web Fetch (Ketch)",
    description: "Compatibility alias for ketch_scrape; fetches one HTTP(S) URL.",
    parameters: webFetchParameters,
    async execute(_id: string, params: WebFetchParams, signal: AbortSignal) {
      const fetched = deps.client
        ? await deps.client.fetchEvidence(params.url, { signal })
        : await fetchEvidence(params.url, { ...deps, signal });
      return result(fetched, { compatibility: "web_fetch" });
    },
  };

  return [searchTool, scrapeTool, crawlTool, codeTool, docsTool, webSearchTool, webFetchTool];
}

export const KETCH_TOOL_NAMES = [
  "ketch_search",
  "ketch_scrape",
  "ketch_crawl",
  "ketch_code",
  "ketch_docs",
  "web_search",
  "web_fetch",
] as const;

export function createKetchTools(deps: KetchToolDeps = {}): AnyTool[] {
  return makeTools(deps);
}

export function registerKetchTools(pi: ExtensionAPI, deps: KetchToolDeps = {}): void {
  for (const tool of makeTools(deps)) pi.registerTool(tool);
}
