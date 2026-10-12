import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ResearchDate = string | null;

export interface Citation {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: ResearchDate;
  /** The meaning of the date, not necessarily an article publication. */
  dateKind?: string;
}

export interface EvidenceEngagement {
  score?: number;
  comments?: number;
  stars?: number;
  forks?: number;
}

export interface CommunityComment {
  author?: string;
  quote: string;
  url: string;
  publishedAt: ResearchDate;
  engagement?: EvidenceEngagement;
}

export interface Evidence {
  id: string;
  title: string;
  url: string;
  source: string;
  snippet: string;
  content?: string;
  communityComments?: CommunityComment[];
  transcript?: { url: string; text: string; language?: string; segments: Array<{ startSeconds: number; text: string }> };
  publishedAt: ResearchDate;
  retrievedAt: string;
  author?: string;
  engagement?: EvidenceEngagement;
  citation: Citation;
  provenance: {
    kind: "search" | "fetch" | "adapter" | "library";
    adapter: string;
    query?: string;
  };
  confidence: number;
}

export type SourceErrorCode = "rate_limited" | "auth_required" | "access_denied" | "schema" | "timeout" | "output_limit" | "network" | "cancelled";

export interface SourceStatus {
  id: string;
  label: string;
  status: "available" | "ok" | "no-results" | "partial" | "failed" | "unconfigured" | "unsupported";
  message?: string;
  errorCode?: SourceErrorCode;
  resultCount?: number;
}

export interface ResearchResult {
  query: string;
  asOf: string;
  cutoff: string;
  recent: Evidence[];
  unknownDate: Evidence[];
  statuses: SourceStatus[];
  unavailableCoverage: string[];
}

export interface SearchOptions {
  signal?: AbortSignal;
  /** Inclusive ISO date window supplied by the research pipeline. */
  after?: string;
  /** Exclusive ISO date window supplied by the research pipeline. */
  before?: string;
  limit?: number;
}

export interface FetchOptions {
  signal?: AbortSignal;
}

export interface KetchResearchDeps {
  search(query: string, options?: SearchOptions): Promise<unknown>;
  fetch(url: string, options?: FetchOptions): Promise<unknown>;
}

export interface SourceAdapter {
  id: string;
  label: string;
  capabilities: readonly ("search" | "fetch")[];
  search?(query: string, options?: SearchOptions): Promise<unknown>;
  fetch?(url: string, options?: FetchOptions): Promise<unknown>;
}

export interface ResearchOptions {
  days?: number;
  limit?: number;
  maxFetch?: number;
  now?: Date;
  signal?: AbortSignal;
  adapters?: readonly SourceAdapter[];
  sourceIds?: readonly string[];
}

export interface LibraryRecord {
  id: string;
  title: string;
  summary: string;
  content: string;
  query?: string;
  createdAt: string;
  updatedAt: string;
  evidence: Evidence[];
  coverage: string[];
}

export interface WatchItem {
  id: string;
  query: string;
  days: number;
  limit: number;
  createdAt: string;
  updatedAt: string;
  lastRefreshAt?: string;
}

export interface PublicationContract {
  id: string;
  label: string;
  publish(record: LibraryRecord, options?: { signal?: AbortSignal }): Promise<{
    status: "published" | "failed";
    reference?: string;
    message?: string;
  }>;
}

export interface ResearchProposal {
  summary: string;
  sources: Citation[];
  date: string;
  confidence: number;
  affectedArea: string;
  changedFiles: string[];
  coverage: string[];
}

export interface ResearchHandoffConfig {
  inboxDir?: string;
}

export interface DoctorReport {
  ok: boolean;
  stateRoot: string;
  writable: boolean;
  dependencies: { search: boolean; fetch: boolean };
  sources: SourceStatus[];
  notes: string[];
}

export type ResearchExtensionAPI = Pick<ExtensionAPI, "registerTool">;
