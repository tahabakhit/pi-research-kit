import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir as systemTmpdir } from "node:os";
import { realpathSync } from "node:fs";
const tmpdir = () => realpathSync(systemTmpdir());
import { join } from "node:path";
import { normalizeSearchResponse, rankEvidence } from "../src/research/normalize.ts";
import { runRecentResearch } from "../src/research/research.ts";
import { LocalResearchLibrary } from "../src/research/library.ts";
import { renderLibraryHtml, renderAtom } from "../src/research/exports.ts";
import { handoffResearchProposal } from "../src/research/proposal.ts";
import { ResearchWatchlist } from "../src/research/watchlist.ts";

test("normalizes common search shapes without inventing dates", () => {
  const items = normalizeSearchResponse({ webPages: { value: [{ name: "A", url: "https://Example.test/a?utm_source=x", snippet: "alpha" }] } });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.url, "https://example.test/a");
  assert.equal(items[0]?.publishedAt, null);
});

test("recent research separates unknown dates and records failures", async () => {
  const result = await runRecentResearch({
    async search() { return { results: [
      { title: "Recent", url: "https://example.test/recent", publishedAt: "2026-09-19", snippet: "query" },
      { title: "Unknown", url: "https://example.test/unknown", snippet: "query" },
    ] }; },
    async fetch() { return { content: "full text" }; },
  }, "query", { now: new Date("2026-09-20T00:00:00Z"), days: 3 });
  assert.equal(result.recent.length, 1);
  assert.equal(result.unknownDate.length, 1);
  assert.deepEqual(result.unavailableCoverage, ["X", "YouTube", "Reddit", "Hacker News", "GitHub", "Polymarket"]);
  assert.equal(result.statuses[0]?.status, "ok");
});

test("ranking is deterministic and deduplication removes tracking variants", () => {
  const items = normalizeSearchResponse({ items: [
    { title: "Same", url: "https://example.test/a?utm_medium=x", snippet: "query" },
    { title: "Same", url: "https://example.test/a", snippet: "query" },
  ] });
  assert.equal(new Set(rankEvidence(items, "query").map((item) => item.url)).size, 1);
});

test("library persists JSON and Markdown and searches locally", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-research-"));
  const library = new LocalResearchLibrary(root);
  const now = new Date().toISOString();
  await library.save({ id: "record-1", title: "Alpha", summary: "A summary", content: "body", createdAt: now, updatedAt: now, evidence: [], coverage: [] });
  assert.equal((await library.search("alpha")).length, 1);
  assert.match(await readFile(join(root, "library", "record-1.md"), "utf8"), /Alpha/);
});

test("HTML and Atom exports escape artifact content", () => {
  const now = new Date().toISOString();
  const record = { id: "x", title: "<script>", summary: "&", content: "<b>unsafe</b>", createdAt: now, updatedAt: now, evidence: [], coverage: [] };
  assert.doesNotMatch(renderLibraryHtml([record]), /<script>/);
  assert.match(renderLibraryHtml([record]), /&lt;script&gt;/);
  assert.match(renderAtom([record]), /&lt;b&gt;unsafe/);
});

test("Research handoff requires approval and never overwrites", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "research-handoff-")), "operator-inbox");
  const proposal = { summary: "summary", sources: [{ id: "s", title: "source", url: "https://example.test", source: "test", publishedAt: null }], date: "2026-09-20", confidence: 0.8, affectedArea: "research", changedFiles: [], coverage: ["unsupported: social"] };
  const skipped = await handoffResearchProposal({ inboxDir: root }, proposal, { approved: false });
  assert.equal(skipped.status, "skipped");
  const written = await handoffResearchProposal({ inboxDir: root }, proposal, { approved: true });
  assert.equal(written.status, "written");
  const again = await handoffResearchProposal({ inboxDir: root }, proposal, { approved: true });
  assert.equal(again.status, "failed");
});

test("watchlist supports CRUD and explicit refresh only", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-watch-"));
  const watchlist = new ResearchWatchlist(root);
  const item = await watchlist.add("bounded query");
  assert.equal((await watchlist.list()).length, 1);
  await watchlist.update(item.id, { days: 7 });
  const result = await watchlist.refresh(item.id, {
    async search() { return { items: [{ title: "Source", url: "https://example.test/source", publishedAt: "2026-09-19" }] }; },
    async fetch() { return { content: "source content" }; },
  }, { now: new Date("2026-09-20T00:00:00Z") });
  assert.equal(result.recent.length, 1);
  assert.equal(await watchlist.remove(item.id), true);
});

test("library rejects symlinked state roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-link-"));
  const target = await mkdtemp(join(tmpdir(), "research-target-"));
  const link = join(root, "linked");
  await symlink(target, link);
  await assert.rejects(() => new LocalResearchLibrary(link).init(), /symlink/i);
});
