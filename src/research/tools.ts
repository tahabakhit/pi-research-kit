import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ResearchHandoffConfig, KetchResearchDeps, LibraryRecord, PublicationContract, ResearchResult, ResearchExtensionAPI, ResearchOptions, SourceAdapter } from "./types.ts";
import { LocalResearchLibrary } from "./library.ts";
import { doctorResearch } from "./doctor.ts";
import { runRecentResearch } from "./research.ts";
import { compareEvidence, synthesizeEvidence } from "./synthesis.ts";
import { ResearchWatchlist } from "./watchlist.ts";
import { handoffConfigFromEnvironment, handoffResearchProposal } from "./proposal.ts";
import { authorizePublication, getPublicationPreview, publishResearch } from "./publication.ts";

export interface ResearchToolDeps extends KetchResearchDeps {
  adapters?: readonly SourceAdapter[];
  sourceRegistry?: { list(): readonly SourceAdapter[] };
  library?: LocalResearchLibrary;
  publication?: PublicationContract;
  handoff?: ResearchHandoffConfig;
  now?: () => Date;
}

export const RESEARCH_TOOL_NAMES = [
  "research_recent",
  "research_synthesize",
  "research_library",
  "research_watchlist",
  "research_doctor",
  "research_publish",
  "research_handoff",
] as const;

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;

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
  if (Buffer.byteLength(source, "utf8") <= MAX_OUTPUT_BYTES && source.split("\n").length <= MAX_OUTPUT_LINES) return source;
  const marker = `\n\n[output truncated to ${MAX_OUTPUT_BYTES} bytes/${MAX_OUTPUT_LINES} lines]`;
  const budget = Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(marker, "utf8"));
  const output: string[] = [];
  let bytes = 0;
  for (const line of source.split("\n").slice(0, MAX_OUTPUT_LINES - 1)) {
    const separatorBytes = output.length ? 1 : 0;
    if (bytes + separatorBytes >= budget) break;
    const room = budget - bytes - separatorBytes;
    const clipped = truncateUtf8(line, room);
    output.push(clipped);
    bytes += separatorBytes + Buffer.byteLength(clipped, "utf8");
    if (clipped !== line) break;
  }
  return `${output.join("\n")}${marker}`;
}

function text(value: unknown): { type: "text"; text: string } {
  return { type: "text", text: boundedText(value) };
}

function optionsFrom(params: { days?: number; limit?: number; maxFetch?: number }, signal?: AbortSignal): ResearchOptions {
  return { ...params, signal };
}

function recordFromResult(result: ResearchResult, now: Date): LibraryRecord {
  const evidence = [...result.recent, ...result.unknownDate];
  return {
    id: randomUUID(),
    title: `Research: ${result.query}`,
    summary: `Found ${result.recent.length} recent and ${result.unknownDate.length} unknown-date sources as of ${result.asOf}.`,
    content: result.recent.map((item) => `- ${item.title}: ${item.snippet}`).join("\n"),
    query: result.query,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    evidence,
    coverage: result.unavailableCoverage,
  };
}

function operationPreview(operation: string, preview: Record<string, unknown>): string {
  return boundedText({ operation, ...preview });
}

async function confirmMutation(ctx: ExtensionContext, operation: string, preview: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
  if (!ctx.hasUI || ctx.mode === "print" || ctx.mode === "json") {
    throw new Error(`${operation} requires interactive human confirmation; refusing in headless mode.`);
  }
  if (ctx.signal?.aborted || signal?.aborted) throw new Error(`${operation} was cancelled.`);
  const serialized = JSON.stringify({ operation, ...preview }, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > 16_000) throw new Error("Confirmation preview is too large; reduce the operation before retrying.");
  const confirmed = await ctx.ui.confirm(`Confirm ${operation}`, serialized);
  if (!confirmed || ctx.signal?.aborted || signal?.aborted) throw new Error(`${operation} was cancelled; no change was made.`);
}

function recordPreview(record: LibraryRecord): Record<string, unknown> {
  return {
    id: record.id,
    title: record.title,
    query: record.query,
    evidenceCount: record.evidence.length,
    contentBytes: Buffer.byteLength(record.content, "utf8"),
  };
}

export function createResearchTools(deps: ResearchToolDeps): ToolDefinition<any, any, any>[] {
  const library = deps.library ?? new LocalResearchLibrary();
  const watchlist = new ResearchWatchlist(library.root, library);
  const adapters = deps.adapters ?? deps.sourceRegistry?.list() ?? [];
  const research = (query: string, params: { days?: number; limit?: number; maxFetch?: number }, signal?: AbortSignal) => runRecentResearch(deps, query, { ...optionsFrom(params, signal), adapters, now: deps.now?.() });

  const recent = {
    name: "research_recent",
    label: "Recent Research",
    description: "Run bounded recent research through supplied Ketch dependencies. Returns dated evidence, unknown-date evidence, source statuses, citations, and unsupported coverage; it never invents missing dates or sources.",
    promptSnippet: "Run bounded recent research with explicit dated and unknown-date evidence.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Research question or search query." }),
      days: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      maxFetch: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })),
    }),
    async execute(_id: string, params: { query: string; days?: number; limit?: number; maxFetch?: number }, signal: AbortSignal) {
      const result = await research(params.query, params, signal);
      return { content: [text(result)], details: result };
    },
  };

  const synthesize = {
    name: "research_synthesize",
    label: "Synthesize Research Evidence",
    description: "Run bounded research and organize host-model-ready evidence and citations. Pair comparisons are document/evidence comparisons, not entity-comparison analysis.",
    promptSnippet: "Organize research evidence into a citation-backed local synthesis without external model spending.",
    parameters: Type.Object({ query: Type.String({ minLength: 1 }), days: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), maxFetch: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })) }),
    async execute(_id: string, params: { query: string; days?: number; limit?: number; maxFetch?: number }, signal: AbortSignal) {
      const result = await research(params.query, params, signal);
      const allEvidence = [...result.recent, ...result.unknownDate];
      const synthesis = synthesizeEvidence(allEvidence, result.query);
      const comparisons = allEvidence.slice(0, 4).flatMap((left, index, items) => items.slice(index + 1).map((right) => compareEvidence(left, right)));
      return { content: [text({ ...synthesis, comparisons, statuses: result.statuses, unavailableCoverage: result.unavailableCoverage })], details: { synthesis, comparisons, statuses: result.statuses, unavailableCoverage: result.unavailableCoverage } };
    },
  };

  const libraryTool = {
    name: "research_library",
    label: "Research Library",
    description: "List or search the private local research library, or save a new bounded research result as JSON and Markdown. Saves require human confirmation and never overwrite records.",
    parameters: Type.Object({ action: StringEnum(["list", "search", "save"] as const), query: Type.Optional(Type.String()), days: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
    async execute(_id: string, params: { action: "list" | "search" | "save"; query?: string; days?: number; limit?: number }, signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) {
      const limit = params.limit ?? 20;
      if (params.action === "list") return { content: [text((await library.list()).slice(0, limit))], details: { action: params.action, limit } };
      if (params.action === "search") return { content: [text((await library.search(params.query ?? "")).slice(0, limit))], details: { action: params.action, limit } };
      if (!params.query?.trim()) throw new Error("Saving research requires a query.");
      const result = await research(params.query, params, signal);
      const record = recordFromResult(result, deps.now?.() ?? new Date());
      await confirmMutation(ctx, "save research library record", recordPreview(record), signal);
      await library.save(record);
      return { content: [text({ saved: recordPreview(record) })], details: { action: params.action, id: record.id } };
    },
  };

  const watch = {
    name: "research_watchlist",
    label: "Research Watchlist",
    description: "List or explicitly add, update, remove, or refresh a research watch item. Every mutation requires human confirmation; edits are locked and atomic, and refresh is on-demand only.",
    parameters: Type.Object({ action: StringEnum(["add", "list", "update", "remove", "refresh"] as const), query: Type.Optional(Type.String()), id: Type.Optional(Type.String()), days: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
    async execute(_id: string, params: { action: "add" | "list" | "update" | "remove" | "refresh"; query?: string; id?: string; days?: number; limit?: number }, signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) {
      const limit = params.limit ?? 20;
      if (params.action === "list") return { content: [text((await watchlist.list()).slice(0, limit))], details: { action: params.action, limit } };
      if (params.action === "add") {
        const query = params.query?.trim() ?? "";
        if (!query) throw new Error("Watch query must not be empty.");
        await confirmMutation(ctx, "add research watch item", { query, days: params.days ?? 30, limit: params.limit ?? 10 }, signal);
        return { content: [text(await watchlist.add(query, params))], details: { action: params.action } };
      }
      if (!params.id) throw new Error(`${params.action} requires a watch item id.`);
      if (params.action === "update") {
        const current = (await watchlist.list()).find((item) => item.id === params.id);
        if (!current) throw new Error(`Watch item not found: ${params.id}`);
        await confirmMutation(ctx, "update research watch item", { id: params.id, before: current, changes: { query: params.query?.trim(), days: params.days, limit: params.limit } }, signal);
        return { content: [text(await watchlist.update(params.id, params, current))], details: { action: params.action, id: params.id } };
      }
      if (params.action === "remove") {
        const current = (await watchlist.list()).find((item) => item.id === params.id);
        if (!current) throw new Error(`Watch item not found: ${params.id}`);
        await confirmMutation(ctx, "remove research watch item", { id: params.id, query: current.query }, signal);
        return { content: [text({ removed: await watchlist.remove(params.id, current) })], details: { action: params.action, id: params.id } };
      }
      const current = (await watchlist.list()).find((item) => item.id === params.id);
      if (!current) throw new Error(`Watch item not found: ${params.id}`);
      await confirmMutation(ctx, "refresh research watch item", { id: current.id, query: current.query, days: params.days ?? current.days, limit: params.limit ?? current.limit }, signal);
      return { content: [text(await watchlist.refresh(params.id, deps, { signal, adapters, days: params.days, limit: params.limit, expected: current }))], details: { action: params.action, id: params.id } };
    },
  };

  const doctor = {
    name: "research_doctor",
    label: "Research Doctor",
    description: "Report configured research dependencies, private state path, and explicit source coverage. It does not authenticate or make network calls.",
    parameters: Type.Object({}),
    async execute() { const report = await doctorResearch(deps, { root: library.root, adapters }); return { content: [text(report)], details: report }; },
  };

  const publish = {
    name: "research_publish",
    label: "Publish Research",
    description: "Publish a library record only through a user-supplied publication contract and interactive human confirmation. The model cannot authorize publication with an argument.",
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    async execute(_id: string, params: { id: string }, _signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) {
      const record = await library.get(params.id);
      if (!record) throw new Error(`Library record not found: ${params.id}`);
      const preview = getPublicationPreview(record, deps.publication);
      if (!preview) throw new Error("Publishing is not configured; no destination was contacted.");
      await confirmMutation(ctx, "publish research record publicly", { ...recordPreview(record), ...preview }, _signal);
      const result = await publishResearch(record, deps.publication, { authorization: authorizePublication(preview), signal: _signal });
      return { content: [text(result)], details: result };
    },
  };

  const handoff = {
    name: "research_handoff",
    label: "Research Proposal Handoff",
    description: "Write a new, non-overwriting proposal to the explicit PI_RESEARCH_INBOX (or supplied config) only after interactive human confirmation. No vault is read.",
    parameters: Type.Object({ summary: Type.String({ minLength: 1 }), date: Type.String({ minLength: 1 }), confidence: Type.Number({ minimum: 0, maximum: 1 }), affectedArea: Type.String({ minLength: 1 }), changedFiles: Type.Array(Type.String()), coverage: Type.Array(Type.String()), sourceUrls: Type.Array(Type.String({ minLength: 1 })) }),
    async execute(_id: string, params: { summary: string; date: string; confidence: number; affectedArea: string; changedFiles: string[]; coverage: string[]; sourceUrls: string[] }, signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) {
      const sources = params.sourceUrls.map((url, index) => ({ id: `source-${index + 1}`, title: url, url, source: "research", publishedAt: null }));
      const preview = { summary: params.summary.trim(), date: params.date.trim(), confidence: params.confidence, affectedArea: params.affectedArea.trim(), changedFiles: [...params.changedFiles], coverage: [...params.coverage], sources: params.sourceUrls, destination: (deps.handoff ?? handoffConfigFromEnvironment()).inboxDir ?? "NOT CONFIGURED" };
      await confirmMutation(ctx, "write research proposal", preview, signal);
      const result = await handoffResearchProposal(deps.handoff ?? handoffConfigFromEnvironment(), { summary: params.summary, date: params.date, confidence: params.confidence, affectedArea: params.affectedArea, changedFiles: params.changedFiles, coverage: params.coverage, sources }, { approved: true, signal });
      return { content: [text(result)], details: result };
    },
  };

  return [recent, synthesize, libraryTool, watch, doctor, publish, handoff];
}

export function registerResearchTools(pi: ResearchExtensionAPI, deps: ResearchToolDeps): void {
  for (const tool of createResearchTools(deps)) pi.registerTool(tool);
}

export type ResearchTool = ReturnType<typeof createResearchTools>[number];
