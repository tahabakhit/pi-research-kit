import type { Evidence, KetchResearchDeps, ResearchOptions, ResearchResult, SourceAdapter, SourceStatus } from "./types.ts";
import { deduplicateEvidence, normalizeFetchResponse, normalizeSearchResponse, rankEvidence } from "./normalize.ts";
import { attachDepth, isYouTubeUrl } from "./enrichment.ts";

const DEFAULT_DAYS = 30;
const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_FETCH = 5;
const MAX_DAYS = 3650;
const MAX_LIMIT = 50;
const UNSUPPORTED_COVERAGE = ["X", "YouTube", "Reddit", "Hacker News", "GitHub", "Polymarket"];
const IMPLEMENTED_COVERAGE: Readonly<Record<string, string>> = {
  "hacker-news": "Hacker News",
  github: "GitHub",
  reddit: "Reddit",
  polymarket: "Polymarket",
  x: "X",
  youtube: "YouTube",
};

function bounded(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(value as number)));
}

function adapterStatus(adapters: readonly SourceAdapter[], selected?: readonly string[]): SourceStatus[] {
  const wanted = selected ? new Set(selected) : null;
  return adapters
    .filter((adapter) => !wanted || wanted.has(adapter.id))
    .map((adapter) => ({
      id: adapter.id,
      label: adapter.label,
      status: adapter.search || adapter.fetch ? "available" : "unsupported",
      ...(!adapter.search ? { message: "No search adapter is registered." } : {}),
    }));
}

function applyFetchedEvidence(item: Evidence, fetched: { title?: string; content: string; publishedAt: string | null }, adapter: string): Evidence {
  return {
    ...item,
    ...(fetched.title ? { title: fetched.title } : {}),
    ...(fetched.content ? { content: fetched.content } : {}),
    ...(item.publishedAt ? {} : fetched.publishedAt ? { publishedAt: fetched.publishedAt } : {}),
    provenance: { ...item.provenance, kind: "fetch", adapter },
    confidence: Math.min(0.95, item.confidence + (fetched.content ? 0.15 : 0)),
    citation: { ...item.citation, ...(fetched.title ? { title: fetched.title } : {}), ...(item.publishedAt ? {} : fetched.publishedAt ? { publishedAt: fetched.publishedAt } : {}) },
  };
}

export async function runRecentResearch(
  deps: KetchResearchDeps,
  query: string,
  options: ResearchOptions = {},
): Promise<ResearchResult> {
  const cleanQuery = query.trim();
  if (!cleanQuery) throw new Error("Research query must not be empty.");
  const now = options.now ?? new Date();
  const asOf = now.toISOString();
  const days = bounded(options.days, DEFAULT_DAYS, MAX_DAYS);
  const limit = Math.max(1, bounded(options.limit, DEFAULT_LIMIT, MAX_LIMIT));
  const maxFetch = bounded(options.maxFetch, DEFAULT_MAX_FETCH, limit);
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const adapters = options.adapters ?? [];
  const statuses: SourceStatus[] = [{ id: "ketch", label: "Ketch search", status: "available" }, ...adapterStatus(adapters, options.sourceIds)];
  const selectedAdapters = adapters.filter((adapter) => !options.sourceIds || options.sourceIds.includes(adapter.id));
  const candidates: Evidence[] = [];

  const runSearch = async (source: string, search: SourceAdapter["search"]): Promise<void> => {
    if (!search) return;
    const status = statuses.find((entry) => entry.id === source);
    try {
      const raw = await search(cleanQuery, { signal: options.signal, after: cutoff, before: asOf, limit });
      const found = normalizeSearchResponse(raw, source, asOf, cleanQuery).slice(0, limit);
      candidates.push(...found);
      const metadataValue = raw !== null && typeof raw === "object" && "sourceMetadata" in raw ? (raw as { sourceMetadata?: unknown }).sourceMetadata : undefined;
      const metadata = metadataValue !== null && typeof metadataValue === "object" && metadataValue !== undefined && "message" in metadataValue && typeof (metadataValue as { message?: unknown }).message === "string"
        ? metadataValue as { message: string; partial?: boolean }
        : undefined;
      if (status) {
        status.status = metadata?.partial ? "partial" : found.length ? "ok" : "no-results";
        status.resultCount = found.length;
        if (metadata?.message) status.message = metadata.message;
        else if (found.length === 0) status.message = "No usable evidence returned; no evidence was invented.";
      }
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      if (status) {
        status.status = "failed";
        const sourceError = error as { code?: unknown };
        const errorCode = typeof sourceError.code === "string" ? sourceError.code : undefined;
        if (errorCode === "rate_limited" || errorCode === "auth_required" || errorCode === "access_denied" || errorCode === "schema" || errorCode === "timeout" || errorCode === "output_limit" || errorCode === "network" || errorCode === "cancelled") status.errorCode = errorCode;
        status.message = error instanceof Error ? error.message : "Search failed.";
      }
    }
  };

  // Ketch is the supplied, generic web boundary. Adapters are optional and never inferred.
  if (!options.sourceIds || options.sourceIds.includes("ketch")) await runSearch("ketch", deps.search);
  for (const adapter of selectedAdapters) await runSearch(adapter.id, adapter.search);

  let ranked = rankEvidence(deduplicateEvidence(candidates).filter(item => !item.publishedAt || (item.publishedAt >= cutoff && item.publishedAt <= asOf)), cleanQuery).slice(0, limit);
  const transcript = selectedAdapters.find(adapter => adapter.id === "youtube-transcript" && adapter.fetch);
  let remainingFetch = maxFetch;
  for (const item of [...ranked]) {
    const adapter = selectedAdapters.find(candidate => candidate.id === item.source && candidate.fetch);
    const useTranscript = Boolean(transcript && isYouTubeUrl(item.url));
    const operations: Array<{id: string; fetch: NonNullable<SourceAdapter["fetch"]>}> = [];
    if (useTranscript) operations.push({id: transcript!.id, fetch: transcript!.fetch!});
    if (adapter?.fetch) operations.push({id: adapter.id, fetch: adapter.fetch});
    else if (item.source === "ketch" && !useTranscript) operations.push({id: "ketch", fetch: deps.fetch});
    for (const operation of operations) {
      if (remainingFetch <= 0) break;
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Research cancelled.");
      remainingFetch -= 1;
      const status = statuses.find(entry => entry.id === operation.id);
      try {
        const raw = await operation.fetch(item.url, {signal: options.signal});
        const fetched = await normalizeFetchResponse(raw, item.url);
        ranked = ranked.map(candidate => {
          if (candidate.id !== item.id) return candidate;
          // Enrichment must not replace a source title with a comments-page label.
          const merged = applyFetchedEvidence(candidate, {...fetched, title: candidate.title, content: [candidate.content, fetched.content].filter(Boolean).join("\n\n")}, operation.id);
          return attachDepth(merged, raw);
        });
        if (status && operation.id === "youtube-transcript") { status.status = "ok"; status.message = "Retrieved configured captions; no audio transcription or account cookies were used."; status.resultCount = (status.resultCount ?? 0) + 1; }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (status) {
          status.status = operation.id === "youtube-transcript" && !status.resultCount ? "failed" : "partial";
          status.message = `Enrichment failed: ${error instanceof Error ? error.message : "unknown error"}. Search evidence remains available.`;
        }
      }
    }
  }

  ranked = rankEvidence(deduplicateEvidence(ranked), cleanQuery).slice(0, limit);
  const recent: Evidence[] = [];
  const unknownDate: Evidence[] = [];
  for (const item of ranked) {
    if (!item.publishedAt) unknownDate.push(item);
    else if (item.publishedAt >= cutoff && item.publishedAt <= asOf) recent.push(item);
  }
  return {
    query: cleanQuery,
    asOf,
    cutoff,
    recent,
    unknownDate,
    statuses,
    unavailableCoverage: UNSUPPORTED_COVERAGE.filter((label) => !Object.entries(IMPLEMENTED_COVERAGE).some(([id, coverage]) => coverage === label && selectedAdapters.some((adapter) => adapter.id === id))),
  };
}

export const researchLimits = { DEFAULT_DAYS, DEFAULT_LIMIT, DEFAULT_MAX_FETCH, MAX_DAYS, MAX_LIMIT } as const;
