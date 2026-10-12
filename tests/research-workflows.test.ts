import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir as systemTmpdir } from "node:os";
import { realpathSync } from "node:fs";
const tmpdir = () => realpathSync(systemTmpdir());
import { join } from "node:path";
import { test } from "node:test";
import { LocalResearchLibrary } from "../src/research/library.ts";
import { registerWorkflowTools } from "../src/research/workflow-tools.ts";
import { discoverWithConfidence, groupDiscoveryEvidence } from "../src/research/synthesis.ts";
import { validateQueryPlan } from "../src/research/query-plan.ts";
import type { Evidence, LibraryRecord, SourceAdapter } from "../src/research/types.ts";

function fixtureDeps(adapters: readonly SourceAdapter[] = []) {
  const calls: string[] = [];
  return {
    calls,
    adapters,
    async search(query: string) {
      calls.push(query);
      return { results: [
        { title: `${query} source one`, url: `https://example.test/${calls.length}-one`, publishedAt: "2026-09-19", snippet: `evidence for ${query}` },
        { title: `${query} source two`, url: `https://example.test/${calls.length}-two`, snippet: `undated evidence for ${query}` },
      ] };
    },
    async fetch() { return { content: "fixture content" }; },
    now: () => new Date("2026-09-20T00:00:00.000Z"),
  };
}

function registeredTools(deps: ReturnType<typeof fixtureDeps>) {
  const tools = new Map<string, any>();
  registerWorkflowTools({ registerTool(tool: any) { tools.set(tool.name, tool); } }, deps);
  return tools;
}

function fixtureEvidence(id: string, title: string, url: string, publishedAt: string | null, snippet = "independent report", confidence = 0.8): Evidence {
  return {
    id,
    title,
    url,
    source: "ketch",
    snippet,
    publishedAt,
    retrievedAt: "2026-09-20T00:00:00.000Z",
    citation: { id, title, url, source: "ketch", publishedAt, dateKind: publishedAt ? "publication" : "unknown" },
    provenance: { kind: "search", adapter: "ketch", query: "fixture" },
    confidence,
  };
}

test("compare keeps entity evidence and statuses separate without a verdict", async () => {
  const deps = fixtureDeps([]);
  const tool = registeredTools(deps).get("research_compare");
  const result = await tool.execute("call", { entities: ["Alpha", "Beta"], question: "recent changes", depth: "shallow" }, new AbortController().signal, undefined);
  assert.equal(result.details.entities.length, 2);
  assert.equal(result.details.entities[0].entity, "Alpha");
  assert.equal(result.details.entities[1].entity, "Beta");
  assert.equal("verdict" in result.details, false);
  assert.match(result.content[0].text, /separately per entity/);
  assert.equal(deps.calls.length, 2);
});

test("discover enriches at most three candidates and labels heuristic limits", async () => {
  const deps = fixtureDeps([]);
  const tool = registeredTools(deps).get("research_discover");
  const result = await tool.execute("call", { domain: "climate", topic: "adaptation", depth: "standard" }, new AbortController().signal, undefined);
  assert.ok(result.details.enriched.length <= 3);
  assert.match(result.details.limitations.join(" "), /not fact verification/i);
  assert.match(result.details.limitations.join(" "), /No confident trend/i);
  assert.equal(deps.calls.length, 3);
});

test("discovery requires multiword overlap and independent dated domains", () => {
  const falseOverlap = [
    fixtureEvidence("one", "Aurora update", "https://one.example/a", "2026-09-19", "first account"),
    fixtureEvidence("two", "Aurora report", "https://two.example/b", "2026-09-19", "second account"),
  ];
  assert.deepEqual(groupDiscoveryEvidence(falseOverlap, { cutoff: "2026-09-01", asOf: "2026-09-20" }), []);

  const sameDomain = [
    fixtureEvidence("three", "Quantum lattice breakthrough", "https://wire.example/a", "2026-09-19"),
    fixtureEvidence("four", "Quantum lattice breakthrough followup", "https://wire.example/b", "2026-09-19"),
  ];
  assert.ok(groupDiscoveryEvidence(sameDomain, { cutoff: "2026-09-01", asOf: "2026-09-20" }).every((group) => !group.eligible));

  const syndicated = [
    fixtureEvidence("five", "Quantum lattice breakthrough", "https://first.example/a", "2026-09-19", "same wire copy"),
    fixtureEvidence("six", "Quantum lattice breakthrough", "https://second.example/b", "2026-09-19", "same wire copy"),
  ];
  assert.ok(groupDiscoveryEvidence(syndicated, { cutoff: "2026-09-01", asOf: "2026-09-20" }).every((group) => !group.eligible));
});

test("discovery excludes old/unknown dates, rejects thin evidence, and keeps useful leads heuristic", () => {
  const useful = [
    fixtureEvidence("seven", "Green hydrogen storage", "https://alpha.example/a", "2026-09-19", "alpha account"),
    fixtureEvidence("eight", "Green hydrogen storage outlook", "https://beta.example/b", "2026-09-18", "beta account"),
    fixtureEvidence("nine", "Green hydrogen storage archive", "https://gamma.example/c", "2025-01-01", "old account"),
    fixtureEvidence("ten", "Green hydrogen storage unknown", "https://delta.example/d", null, "undated account"),
  ];
  const options = { cutoff: "2026-09-01", asOf: "2026-09-20", excludedTerms: new Set<string>() };
  const groups = groupDiscoveryEvidence(useful, options);
  assert.ok(groups.some((group) => group.eligible && group.domainCount >= 2));
  const discovered = discoverWithConfidence(useful, options);
  assert.ok(discovered.some((candidate) => candidate.accepted));
  assert.equal(discovered.find((candidate) => candidate.evidence.title.includes("archive"))?.eligible, false);
  assert.equal(discovered.find((candidate) => candidate.evidence.title.includes("unknown"))?.eligible, false);
  assert.equal(discoverWithConfidence([useful[0]!], options)[0]?.accepted, false);
  assert.ok(discovered.every((candidate) => candidate.reason.length > 0));
});

test("query plans are typed, bounded, and cancellation is cumulative", async () => {
  assert.throws(() => validateQueryPlan({ version: 1, workflow: "compare", entities: ["a", "b"], queries: ["x".repeat(501), "ok"] }), /500-character/);
  assert.throws(() => validateQueryPlan({ version: 1, workflow: "discover", scope: "global", topic: "topic", budget: { maxQueries: 99 } }), /maxQueries/);
  const plan = validateQueryPlan({ version: 1, workflow: "compare", entities: ["Alpha", "Beta"], queries: ["Alpha exact", "Beta exact"], budget: { maxQueries: 2, maxFetch: 1 } });
  assert.equal(plan.budget.maxFetch, 1);

  const controller = new AbortController();
  controller.abort(new Error("fixture cancellation"));
  const tool = registeredTools(fixtureDeps([])).get("research_compare");
  await assert.rejects(() => tool.execute("call", { entities: ["Alpha", "Beta"], question: "recent changes" }, controller.signal, undefined), /fixture cancellation/);

  const result = await tool.execute("call", { queryPlan: plan }, new AbortController().signal, undefined);
  assert.match(result.content[0].text, /https:\/\/example\.test\//);
});

test("export renders selected local records read-only and escapes artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-workflow-export-"));
  const library = new LocalResearchLibrary(root);
  const now = new Date().toISOString();
  const record: LibraryRecord = {
    id: "fixture-1",
    title: "<script>alert(1)</script>",
    summary: "& unsafe",
    content: "<b>unsafe</b>",
    createdAt: now,
    updatedAt: now,
    evidence: [],
    coverage: [],
  };
  await library.save(record);
  const before = await readFile(join(root, "library", "fixture-1.json"), "utf8");
  const deps = { ...fixtureDeps([]), library };
  const tool = registeredTools(deps).get("research_export");
  const result = await tool.execute("call", { ids: ["fixture-1"], format: "html" }, new AbortController().signal, undefined);
  assert.doesNotMatch(result.content[0].text, /<script>/);
  assert.match(result.content[0].text, /&lt;script&gt;/);
  const after = await readFile(join(root, "library", "fixture-1.json"), "utf8");
  assert.equal(after, before);

  const markdown = await tool.execute("call", { ids: ["fixture-1"], format: "markdown" }, new AbortController().signal, undefined);
  assert.doesNotMatch(markdown.content[0].text, /<b>unsafe<\/b>/);
  await writeFile(join(root, "sentinel"), "caller-owned");
});
