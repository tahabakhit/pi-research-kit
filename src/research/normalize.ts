import { createHash } from "node:crypto";
import type { Evidence, Citation, EvidenceEngagement } from "./types.ts";

const DATE_FIELDS = ["publishedAt", "published_at", "published", "date", "pubDate", "createdAt", "created_at", "timestamp"];
const TITLE_FIELDS = ["title", "name", "headline"];
const URL_FIELDS = ["url", "link", "href", "uri"];
const TEXT_FIELDS = ["snippet", "description", "summary", "text", "content", "body"];

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(record: Record<string, unknown>, fields: readonly string[]): string {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstUrl(record: Record<string, unknown>): string {
  for (const field of URL_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    const nested = objectRecord(value);
    if (nested && typeof nested.href === "string" && nested.href.trim()) return nested.href.trim();
  }
  return "";
}

export function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

export function canonicalUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || !url.hostname) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$|source$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return null;
  }
}

export function evidenceId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 20);
}

function candidateItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = objectRecord(value);
  if (!record) return [];
  for (const key of ["results", "items", "data", "organic_results", "organic", "searchResults", "documents", "hits", "webPages", "pages", "entries", "articles", "value"]) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested;
    const nestedRecord = objectRecord(nested);
    if (nestedRecord) {
      const nestedItems = candidateItems(nestedRecord);
      if (nestedItems.length) return nestedItems;
    }
  }
  return [value];
}

function resultFromItem(item: unknown, source: string, retrievedAt: string, query?: string): Evidence | null {
  const record = objectRecord(item);
  if (!record) return null;
  const url = canonicalUrl(firstUrl(record));
  if (!url) return null;
  const title = firstString(record, TITLE_FIELDS) || url;
  const snippet = firstString(record, TEXT_FIELDS);
  const content = firstString(record, ["content", "body", "text"]);
  const publishedAt = DATE_FIELDS.map((field) => normalizeDate(record[field])).find(Boolean) ?? null;
  const author = firstString(record, ["author", "byline", "creator"]) || undefined;
  const engagementRecord = objectRecord(record.engagement);
  const engagement: EvidenceEngagement | undefined = engagementRecord ? {
    ...(typeof engagementRecord.score === "number" && Number.isFinite(engagementRecord.score) ? { score: engagementRecord.score } : {}),
    ...(typeof engagementRecord.comments === "number" && Number.isFinite(engagementRecord.comments) ? { comments: engagementRecord.comments } : {}),
    ...(typeof engagementRecord.stars === "number" && Number.isFinite(engagementRecord.stars) ? { stars: engagementRecord.stars } : {}),
    ...(typeof engagementRecord.forks === "number" && Number.isFinite(engagementRecord.forks) ? { forks: engagementRecord.forks } : {}),
  } : undefined;
  const id = evidenceId(url);
  const dateKind = typeof record.dateKind === "string" && ["publication", "submission", "repository-update", "market-created"].includes(record.dateKind) ? record.dateKind : publishedAt ? "publication" : "unknown";
  const citation: Citation = { id, title, url, source, publishedAt, dateKind };
  return {
    id,
    title,
    url,
    source,
    snippet,
    ...(content && content !== snippet ? { content } : {}),
    publishedAt,
    retrievedAt,
    ...(author ? { author } : {}),
    ...(engagement && Object.keys(engagement).length ? { engagement } : {}),
    citation,
    provenance: { kind: "search", adapter: source, ...(query ? { query } : {}) },
    confidence: publishedAt ? 0.65 : 0.45,
  };
}

export function normalizeSearchResponse(
  value: unknown,
  source = "ketch",
  retrievedAt = new Date().toISOString(),
  query?: string,
): Evidence[] {
  return candidateItems(value)
    .map((item) => resultFromItem(item, source, retrievedAt, query))
    .filter((item): item is Evidence => item !== null);
}

export async function normalizeFetchResponse(value: unknown, url: string): Promise<{ title?: string; content: string; publishedAt: string | null }> {
  let payload = value;
  if (typeof value === "string") return { content: value, publishedAt: null };
  const response = objectRecord(value);
  if (response && typeof response.text === "function") {
    payload = await (response.text as () => Promise<unknown>)();
  } else if (response && typeof response.json === "function") {
    payload = await (response.json as () => Promise<unknown>)();
  }
  if (typeof payload === "string") return { content: payload, publishedAt: null };
  const record = objectRecord(payload);
  if (!record) return { content: "", publishedAt: null };
  return {
    title: firstString(record, TITLE_FIELDS) || undefined,
    content: firstString(record, ["content", "text", "body", "markdown", "html", "description"]),
    publishedAt: DATE_FIELDS.map((field) => normalizeDate(record[field])).find(Boolean) ?? null,
  };
}

export function deduplicateEvidence(items: readonly Evidence[]): Evidence[] {
  const byUrl = new Map<string, Evidence>();
  for (const item of items) {
    const url = canonicalUrl(item.url) ?? item.url;
    const existing = byUrl.get(url);
    if (!existing || evidenceSortKey(item) < evidenceSortKey(existing)) byUrl.set(url, { ...item, url, id: evidenceId(url), citation: { ...item.citation, url, id: evidenceId(url) } });
  }
  return [...byUrl.values()];
}

function evidenceSortKey(item: Evidence): string {
  return [item.publishedAt ?? "9999", item.title.toLocaleLowerCase(), item.source, item.url].join("\u0000");
}

export function rankEvidence(items: readonly Evidence[], query = ""): Evidence[] {
  const terms = query.toLocaleLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const score = (item: Evidence): number => {
    const haystack = `${item.title} ${item.snippet} ${item.content ?? ""}`.toLocaleLowerCase();
    const matches = terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0);
    const dateBonus = item.publishedAt ? 1 : 0;
    return matches * 10 + dateBonus + item.confidence;
  };
  return [...items].sort((a, b) =>
    score(b) - score(a) ||
    (b.publishedAt ?? "") .localeCompare(a.publishedAt ?? "") ||
    a.url.localeCompare(b.url),
  );
}
