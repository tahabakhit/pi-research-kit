import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { LocalResearchLibrary } from "./library.ts";
import { renderAtom, renderLibraryHtml } from "./exports.ts";
import { createDefaultSourceAdapters } from "./sources.ts";
import { runRecentResearch } from "./research.ts";
import { groupDiscoveryEvidence, discoverWithConfidence } from "./synthesis.ts";
import { validateQueryPlan, type ValidatedQueryPlan } from "./query-plan.ts";
import type { Evidence, LibraryRecord, ResearchExtensionAPI, ResearchResult, SourceAdapter } from "./types.ts";
import type { ResearchToolDeps } from "./tools.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;
const MAX_WORKFLOW_DAYS = 365;
const MAX_WORKFLOW_LIMIT = 20;
const MAX_WORKFLOW_FETCH = 10;
const MAX_WORKFLOW_EVIDENCE = 10;
const MAX_QUERY_LENGTH = 500;

type WorkflowDepth = "shallow" | "standard" | "deep";
type ProgressUpdate = (update: unknown) => void;

const DEFAULT_WORKFLOW_DAYS = 30;
const DEPTH_DEFAULTS: Record<WorkflowDepth, { limit: number; maxFetch: number }> = {
  shallow: { limit: 5, maxFetch: 0 },
  standard: { limit: 10, maxFetch: 5 },
  deep: { limit: 20, maxFetch: 10 },
};

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
}

function boundedText(value: unknown): string {
  let source: string;
  try {
    source = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "undefined";
  } catch {
    source = String(value);
  }
  const marker = `\n[output truncated to ${MAX_OUTPUT_BYTES} bytes/${MAX_OUTPUT_LINES} lines]`;
  if (Buffer.byteLength(source, "utf8") <= MAX_OUTPUT_BYTES && source.split("\n").length <= MAX_OUTPUT_LINES) return source;
  const budget = Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(marker, "utf8"));
  const lines: string[] = [];
  let bytes = 0;
  for (const line of source.split("\n").slice(0, MAX_OUTPUT_LINES - 1)) {
    const separator = lines.length ? 1 : 0;
    if (bytes + separator >= budget) break;
    const clipped = truncateUtf8(line, budget - bytes - separator);
    lines.push(clipped);
    bytes += separator + Buffer.byteLength(clipped, "utf8");
    if (clipped !== line) break;
  }
  return `${lines.join("\n")}${marker}`;
}

function text(value: unknown): { type: "text"; text: string } {
  return { type: "text", text: boundedText(value) };
}

function progress(onUpdate: ProgressUpdate | undefined, message: string): void {
  onUpdate?.({ content: [{ type: "text", text: message }] });
}

async function withProgress<T>(label: string, onUpdate: ProgressUpdate | undefined, work: () => Promise<T>): Promise<T> {
  progress(onUpdate, `${label}: started`);
  const timer = setInterval(() => progress(onUpdate, `${label}: still working`), 60_000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

function cleanRequired(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const result = value.trim();
  if (!result) throw new Error(`${name} must not be empty.`);
  if (result.length > maxLength) throw new Error(`${name} exceeds the ${maxLength}-character bound.`);
  return result;
}

function depthOf(value: unknown): WorkflowDepth {
  if (value === undefined) return "standard";
  if (value === "shallow" || value === "standard" || value === "deep") return value;
  throw new Error("depth must be shallow, standard, or deep.");
}

function boundedInteger(value: unknown, fallback: number, maximum: number, minimum = 1): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error("A workflow bound must be an integer.");
  if (value < minimum || value > maximum) throw new Error(`Workflow bounds must be between ${minimum} and ${maximum}.`);
  return value;
}

function asOfDate(value: unknown, fallback: Date): Date {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length > 40) throw new Error("date must be a bounded ISO date string.");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("date must be a valid ISO date.");
  return parsed;
}

function researchBounds(params: { depth?: unknown; days?: unknown; dateRangeDays?: unknown; date?: unknown }, deps: ResearchToolDeps): { depth: WorkflowDepth; days: number; limit: number; maxFetch: number; now: Date } {
  const depth = depthOf(params.depth);
  const defaults = DEPTH_DEFAULTS[depth];
  return {
    depth,
    // Depth controls change/result budgets only. Date eligibility remains an
    // explicit, shared window rather than silently changing with depth.
    days: boundedInteger(params.days ?? params.dateRangeDays, DEFAULT_WORKFLOW_DAYS, MAX_WORKFLOW_DAYS),
    limit: boundedInteger((params as { limit?: unknown }).limit, defaults.limit, MAX_WORKFLOW_LIMIT),
    maxFetch: boundedInteger((params as { maxFetch?: unknown }).maxFetch, defaults.maxFetch, MAX_WORKFLOW_FETCH, 0),
    now: asOfDate(params.date, deps.now?.() ?? new Date()),
  };
}

function adaptersFor(deps: ResearchToolDeps): readonly SourceAdapter[] {
  // An explicitly empty adapter list is meaningful in fixtures and in an
  // offline installation. Defaults are only created when no choice was given.
  return deps.adapters ?? deps.sourceRegistry?.list() ?? createDefaultSourceAdapters();
}

function researchOptions(bounds: ReturnType<typeof researchBounds>, adapters: readonly SourceAdapter[], signal: AbortSignal, maxFetch = bounds.maxFetch) {
  return { days: bounds.days, limit: bounds.limit, maxFetch, now: bounds.now, signal, adapters };
}

function fetchAllocation(remaining: number, remainingQueries: number): number {
  if (remaining <= 0 || remainingQueries <= 0) return 0;
  // Reserve a disjoint slice before each query so cumulative fetch work can
  // never exceed the workflow/plan budget, even when a source is slow.
  return Math.min(remaining, Math.ceil(remaining / remainingQueries));
}

function planBounds(params: Record<string, unknown>, deps: ResearchToolDeps, plan?: ValidatedQueryPlan): ReturnType<typeof researchBounds> {
  return researchBounds({
    ...params,
    ...(plan?.depth === undefined ? {} : { depth: plan.depth }),
    ...(plan?.days === undefined ? {} : { days: plan.days }),
    ...(plan?.date === undefined ? {} : { date: plan.date }),
    ...(plan?.budget.limit === undefined ? {} : { limit: plan.budget.limit }),
    ...(plan?.budget.maxFetch === undefined ? {} : { maxFetch: plan.budget.maxFetch }),
  }, deps);
}


function citationEvidence(item: Evidence): Record<string, unknown> {
  return {
    id: item.id,
    title: truncateUtf8(item.title, 300),
    url: item.url,
    source: truncateUtf8(item.source, 200),
    snippet: truncateUtf8(item.snippet, 600),
    ...(item.content ? { content: truncateUtf8(item.content, 800) } : {}),
    publishedAt: item.publishedAt,
    retrievedAt: item.retrievedAt,
    provenance: { kind: item.provenance.kind, adapter: item.provenance.adapter, ...(item.provenance.query ? { query: item.provenance.query } : {}) },
    citation: {
      id: item.citation.id,
      title: truncateUtf8(item.citation.title, 300),
      url: item.citation.url,
      source: truncateUtf8(item.citation.source, 200),
      publishedAt: item.citation.publishedAt,
      dateKind: item.citation.dateKind,
    },
    confidence: item.confidence,
    ...(item.communityComments ? { communityComments: item.communityComments.slice(0, 3).map(comment => ({ ...comment, quote: truncateUtf8(comment.quote, 600) })), commentsExcerpted: item.communityComments.length > 3 } : {}),
    ...(item.transcript ? { transcript: { url: item.transcript.url, language: item.transcript.language, excerpt: truncateUtf8(item.transcript.text, 800), segments: item.transcript.segments.slice(0, 5) }, transcriptExcerpted: true } : {}),
  };
}

function resultEvidence(result: ResearchResult): Record<string, unknown> {
  return {
    recent: result.recent.slice(0, MAX_WORKFLOW_EVIDENCE).map(citationEvidence),
    unknownDate: result.unknownDate.slice(0, MAX_WORKFLOW_EVIDENCE).map(citationEvidence),
    statuses: result.statuses.map((status) => ({
      id: truncateUtf8(status.id, 100),
      label: truncateUtf8(status.label, 200),
      status: status.status,
      ...(status.message ? { message: truncateUtf8(status.message, 500) } : {}),
      ...(status.errorCode ? { errorCode: status.errorCode } : {}),
      ...(status.resultCount === undefined ? {} : { resultCount: status.resultCount }),
    })),
    unavailableCoverage: result.unavailableCoverage.map((item) => truncateUtf8(item, 200)),
    asOf: result.asOf,
    cutoff: result.cutoff,
  };
}

function queryFor(entity: string, question: string): string {
  return `${entity} ${question}`.trim().slice(0, MAX_QUERY_LENGTH);
}

function executeSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Research workflow was cancelled.");
}

function markdownEscape(value: string): string {
  return value.replace(/[\\`*_[\]<>]/g, (character) => `\\${character}`);
}

function markdownUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "#";
    return `<${url.toString().replace(/[<>\n]/g, "")}>`;
  } catch {
    return "#";
  }
}

function renderSafeMarkdown(records: readonly LibraryRecord[]): string {
  return records.map((record) => {
    const evidence = record.evidence.map((item) => `- [${markdownEscape(item.title)}](${markdownUrl(item.url)}) — ${markdownEscape(item.publishedAt ?? "date unknown")} (${markdownEscape(item.source)})`).join("\n");
    return [
      `# ${markdownEscape(record.title)}`,
      "",
      markdownEscape(record.summary),
      "",
      `- Created: ${markdownEscape(record.createdAt)}`,
      `- Updated: ${markdownEscape(record.updatedAt)}`,
      ...(record.query ? [`- Query: ${markdownEscape(record.query)}`] : []),
      "",
      markdownEscape(record.content),
      "",
      "## Sources",
      evidence || "No sources.",
      "",
      "## Coverage",
      record.coverage.map((item) => `- ${markdownEscape(item)}`).join("\n") || "- Not reported",
      "",
    ].join("\n");
  }).join("\n");
}

function validLibraryId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(id);
}

async function readRecordWithoutMutation(library: LocalResearchLibrary, id: string): Promise<LibraryRecord | null> {
  if (!validLibraryId(id)) return null;
  return library.get(id);
}

function registerTool(pi: ResearchExtensionAPI, tool: ToolDefinition<any, any, any>): void {
  pi.registerTool(tool);
}

export { validateQueryPlan, QUERY_PLAN_LIMITS } from "./query-plan.ts";
export type { HostQueryPlan, QueryPlanBudget, QueryPlanWorkflow, ValidatedQueryPlan } from "./query-plan.ts";

export function registerWorkflowTools(pi: ResearchExtensionAPI, deps: ResearchToolDeps): void {
  const library = deps.library ?? new LocalResearchLibrary();
  const adapters = adaptersFor(deps);

  registerTool(pi, {
    name: "research_compare",
    label: "Compare Research Evidence",
    description: "Research 2-4 explicitly named entities with one common question and return separate cited evidence and source statuses. This tool does not produce a comparative verdict; date, depth, and output are bounded.",
    promptSnippet: "Compare entities using separate cited evidence without inventing a verdict.",
    parameters: Type.Object({
      entities: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 2, maxItems: 4 })),
      question: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH })),
      queryPlan: Type.Optional(Type.Any()),
      days: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_DAYS })),
      dateRangeDays: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_DAYS })),
      date: Type.Optional(Type.String({ maxLength: 40 })),
      depth: Type.Optional(StringEnum(["shallow", "standard", "deep"] as const)),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_LIMIT })),
      maxFetch: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WORKFLOW_FETCH })),
    }),
    async execute(_id: string, params: { entities?: string[]; question?: string; queryPlan?: unknown; days?: number; dateRangeDays?: number; date?: string; depth?: WorkflowDepth; limit?: number; maxFetch?: number }, signal: AbortSignal, onUpdate: ProgressUpdate) {
      return withProgress("research_compare", onUpdate, async () => {
        executeSignal(signal);
        const plan = params.queryPlan === undefined ? undefined : validateQueryPlan(params.queryPlan, "compare");
        const rawEntities = plan?.entities ?? params.entities;
        if (!Array.isArray(rawEntities) || rawEntities.length < 2 || rawEntities.length > 4) throw new Error("research_compare requires 2-4 entities or a bounded compare query plan.");
        const entities = rawEntities.map((entity) => cleanRequired(entity, "entity", 200));
        const question = plan?.question ?? (params.question === undefined ? undefined : cleanRequired(params.question, "question", MAX_QUERY_LENGTH));
        if (!question && !plan?.queries.length) throw new Error("research_compare requires a question or explicit plan queries.");
        if (plan && plan.budget.maxQueries < entities.length) throw new Error("compare query plan maxQueries is smaller than the entity count.");
        const bounds = planBounds(params as unknown as Record<string, unknown>, deps, plan);
        const queries = plan?.queries.length ? [...plan.queries] : entities.map((entity) => queryFor(entity, question as string));
        if (queries.length !== entities.length) throw new Error("research_compare requires exactly one query per entity.");
        let remainingFetch = bounds.maxFetch;
        const entityResults: Array<Record<string, unknown>> = [];
        for (const [index, entity] of entities.entries()) {
          executeSignal(signal);
          progress(onUpdate, `research_compare: researching entity ${index + 1} of ${entities.length}`);
          const allocation = fetchAllocation(remainingFetch, entities.length - index);
          remainingFetch -= allocation;
          const result = await runRecentResearch(deps, queries[index] as string, researchOptions(bounds, adapters, signal, allocation));
          entityResults.push({ entity, query: result.query, evidence: resultEvidence(result) });
        }
        const details = { workflow: "compare", question: question ?? null, queryPlan: plan ?? null, depth: bounds.depth, days: bounds.days, asOf: bounds.now.toISOString(), entities: entityResults, limitations: ["Evidence is reported separately per entity.", "No comparative verdict or unsupported claim was generated.", "Host-supplied queries are bounded and retain each result's source/date provenance."] };
        return { content: [text(details)], details };
      });
    },
  });

  registerTool(pi, {
    name: "research_discover",
    label: "Discover Research Leads",
    description: "Research a scoped domain or explicitly requested global topic, nominate only dated multiword/entity-topic leads with independent-domain corroboration, and enrich no more than three candidates. Heuristics are not fact verification.",
    promptSnippet: "Discover and cautiously enrich research leads with honest evidence limits.",
    parameters: Type.Object({
      domain: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      scope: Type.Optional(StringEnum(["domain", "global"] as const)),
      topic: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      queryPlan: Type.Optional(Type.Any()),
      days: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_DAYS })),
      dateRangeDays: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_DAYS })),
      date: Type.Optional(Type.String({ maxLength: 40 })),
      depth: Type.Optional(StringEnum(["shallow", "standard", "deep"] as const)),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_LIMIT })),
      maxFetch: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WORKFLOW_FETCH })),
    }),
    async execute(_id: string, params: { domain?: string; scope?: "domain" | "global"; topic?: string; queryPlan?: unknown; days?: number; dateRangeDays?: number; date?: string; depth?: WorkflowDepth; limit?: number; maxFetch?: number }, signal: AbortSignal, onUpdate: ProgressUpdate) {
      return withProgress("research_discover", onUpdate, async () => {
        executeSignal(signal);
        const plan = params.queryPlan === undefined ? undefined : validateQueryPlan(params.queryPlan, "discover");
        const scope = plan?.scope ?? params.scope ?? (params.domain ? "domain" : "global");
        const domain = plan?.domain ?? (params.domain === undefined ? undefined : cleanRequired(params.domain, "domain", 200));
        if (scope === "domain" && !domain) throw new Error("research_discover requires a domain, or explicitly set scope=global.");
        if (scope === "global" && params.domain !== undefined) throw new Error("global discovery must not include a domain; explicitly choose domain scope instead.");
        if (typeof deps.search !== "function" && !adapters.some((adapter) => typeof adapter.search === "function")) throw new Error("Global discovery requires a meaningful public search or source adapter; provide a domain scope instead.");
        const topic = plan?.topic ?? (params.topic === undefined ? undefined : cleanRequired(params.topic, "topic", 300));
        if (!topic && !plan?.queries.length) throw new Error("research_discover requires a topic or explicit plan queries.");
        const bounds = planBounds(params as unknown as Record<string, unknown>, deps, plan);
        const baseQuery = `${domain ? `${domain} ` : ""}${topic ?? ""}`.trim().slice(0, MAX_QUERY_LENGTH);
        const plannedQueries = plan?.queries.length ? [...plan.queries] : [baseQuery];
        const maxQueries = plan?.budget.maxQueries ?? 4;
        if (plannedQueries.length > maxQueries) throw new Error("Discovery query budget is smaller than the supplied query plan.");
        let remainingFetch = bounds.maxFetch;
        const querySlots = plan?.queries.length ? plan.queries.length : Math.min(maxQueries, 4);
        let remainingQueries = Math.max(1, querySlots);
        const initialAllocation = fetchAllocation(remainingFetch, remainingQueries);
        remainingFetch -= initialAllocation;
        remainingQueries -= 1;
        const initial = await runRecentResearch(deps, plannedQueries[0] ?? baseQuery, researchOptions(bounds, adapters, signal, initialAllocation));
        const candidates = [...initial.recent, ...initial.unknownDate];
        const excluded = new Set(`${domain ?? ""} ${topic ?? ""}`.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3));
        const discoveryOptions = { cutoff: initial.cutoff, asOf: initial.asOf, excludedTerms: excluded, minimumConfidence: 0.65, minimumCorroboration: 1, minimumDomains: 2 } as const;
        const groups = groupDiscoveryEvidence(initial.recent, discoveryOptions);
        const nominations = discoverWithConfidence(candidates, discoveryOptions).slice(0, Math.min(6, MAX_WORKFLOW_LIMIT)).map((candidate) => ({ ...citationEvidence(candidate.evidence), discovery: { accepted: candidate.accepted, eligible: candidate.eligible, score: candidate.score, corroboration: candidate.corroboration, sourceCount: candidate.sourceCount, domainCount: candidate.domainCount, reason: candidate.reason } }));
        const enriched: Array<Record<string, unknown>> = [];
        const plannedResults: Array<Record<string, unknown>> = [];
        const enrichmentCandidates = candidates.slice(0, 3);
        const remainingPlanQueries = plan?.queries.length ? plan.queries.slice(1) : [];
        const enrichmentCount = plan?.queries.length ? remainingPlanQueries.length : enrichmentCandidates.length;
        for (let index = 0; index < enrichmentCount; index += 1) {
          executeSignal(signal);
          if (remainingQueries <= 0) break;
          const candidate = enrichmentCandidates[index];
          const plannedQuery = remainingPlanQueries[index];
          progress(onUpdate, `research_discover: ${plannedQuery ? "executing planned query" : "enriching candidate"} ${index + 1} of ${enrichmentCount}`);
          const enrichmentQuery = plannedQuery ?? `${domain ? `${domain} ` : ""}${topic ?? ""} ${candidate?.title ?? ""}`.slice(0, MAX_QUERY_LENGTH);
          const allocation = fetchAllocation(remainingFetch, remainingQueries);
          remainingFetch -= allocation;
          remainingQueries -= 1;
          const enrichment = await runRecentResearch(deps, enrichmentQuery, researchOptions({ ...bounds, limit: Math.min(bounds.limit, 10) }, adapters, signal, allocation));
          if (candidate && index < 3) enriched.push({ candidate: citationEvidence(candidate), query: enrichment.query, evidence: resultEvidence(enrichment) });
          else plannedResults.push({ query: enrichment.query, evidence: resultEvidence(enrichment) });
        }
        const solidFindings = nominations.filter((candidate) => (candidate.discovery as { accepted: boolean }).accepted).length > 0;
        const outcome = solidFindings ? "heuristic-leads" : candidates.length === 0 ? "insufficient-evidence" : "no-solid-findings";
        const details = {
          workflow: "discover",
          scope,
          domain: domain ?? null,
          topic: topic ?? null,
          queryPlan: plan ?? null,
          depth: bounds.depth,
          days: bounds.days,
          asOf: bounds.now.toISOString(),
          initial: resultEvidence(initial),
          thresholds: { minimumConfidence: 0.65, minimumCorroboration: 1, minimumDomains: 2, eligibility: `publishedAt between ${initial.cutoff} and ${initial.asOf}; unknown dates excluded` },
          nominations,
          groups,
          enriched,
          plannedResults,
          outcome,
          limitations: [
            "Nominations are deterministic research leads, not verified facts or calibrated confidence; this is not fact verification.",
            "Multiword/entity-topic overlap is required; same-domain copies and identical syndicated text do not count as independent corroboration.",
            "Unknown-date and out-of-window evidence is retained in citations but excluded from solid-findings eligibility.",
            outcome === "insufficient-evidence" ? "Insufficient evidence was returned to nominate a lead." : outcome === "no-solid-findings" ? "No solid findings and no confident trend: the explicit evidence, date, confidence, and independent-domain thresholds were not met." : "At least one heuristic lead met the explicit floor; this is not a factual trend claim.",
          ],
        };
        return { content: [text(details)], details };
      });
    },
  });

  registerTool(pi, {
    name: "research_export",
    label: "Export Research Library",
    description: "Render selected local research library IDs as escaped HTML, Atom, or Markdown. This is read-only: it makes no network requests and does not write files; save the returned content explicitly if desired.",
    promptSnippet: "Render selected local research records without writing or fetching anything.",
    parameters: Type.Object({
      ids: Type.Array(Type.String({ minLength: 1, maxLength: 101 }), { minItems: 1, maxItems: 50 }),
      format: StringEnum(["html", "atom", "markdown"] as const),
      title: Type.Optional(Type.String({ maxLength: 200 })),
    }),
    async execute(_id: string, params: { ids: string[]; format: "html" | "atom" | "markdown"; title?: string }, _signal: AbortSignal, onUpdate: ProgressUpdate) {
      return withProgress("research_export", onUpdate, async () => {
        const ids = params.ids.slice(0, 50);
        const records: LibraryRecord[] = [];
        const missing: string[] = [];
        for (const id of ids) {
          const record = await readRecordWithoutMutation(library, id);
          if (record) records.push(record);
          else missing.push(id);
        }
        const title = params.title?.trim().slice(0, 200) || "Research Library";
        const content = params.format === "html"
          ? renderLibraryHtml(records, title)
          : params.format === "atom"
            ? renderAtom(records, title)
            : renderSafeMarkdown(records);
        const details = { workflow: "export", format: params.format, requestedIds: ids, foundIds: records.map((record) => record.id), missingIds: missing, recordCount: records.length, outputBytes: Buffer.byteLength(content, "utf8") };
        return { content: [text(content)], details };
      });
    },
  });
}