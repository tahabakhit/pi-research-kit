import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createGitHubAdapter,
  createHackerNewsAdapter,
  GITHUB_REPOSITORY_SEARCH_ENDPOINT,
  HACKER_NEWS_SEARCH_ENDPOINT,
  SourceAdapterError,
} from "../src/research/sources.ts";
import { runRecentResearch } from "../src/research/research.ts";

function response(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, ...init });
}

test("Hacker News Algolia fixture maps date, discussion engagement, and a safe URL", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const adapter = createHackerNewsAdapter({
    fetch: async (input, init) => {
      request = { url: String(input), init };
      return response({ hits: [{ objectID: "123", title: "Algolia story", url: "https://example.test/story", created_at: "2026-09-19T12:00:00.000Z", author: "alice", points: 42, num_comments: 7, story_text: "A fixture story" }] });
    },
  });
  const result = await adapter.search!("algolia", { after: "2026-09-17T00:00:00.000Z", before: "2026-09-20T00:00:00.000Z", limit: 5 }) as Array<Record<string, unknown>>;
  assert.equal(result.length, 1);
  const item = result[0] as Record<string, unknown>;
  assert.equal(item.publishedAt, "2026-09-19T12:00:00.000Z");
  assert.deepEqual(item.engagement, { score: 42, comments: 7 });
  assert.equal(item.url, "https://example.test/story");
  assert.match(request?.url ?? "", /numericFilters=created_at_i%3E%3D/);
  assert.equal(request?.init?.redirect, "error");
});

test("GitHub fixture uses public repository search without inherited credentials", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const adapter = createGitHubAdapter({
    fetch: async (input, init) => {
      request = { url: String(input), init };
      return response({ total_count: 1, items: [{ full_name: "research/example", html_url: "https://github.com/research/example", description: "A public repository", updated_at: "2026-09-18T00:00:00Z", stargazers_count: 11, forks_count: 3, owner: { login: "research" } }] });
    },
  });
  const result = await adapter.search!("research", { after: "2026-09-01T00:00:00.000Z", before: "2026-09-20T00:00:00.000Z" }) as Array<Record<string, unknown>>;
  const item = result[0] as Record<string, unknown>;
  assert.equal(item.title, "research/example");
  assert.deepEqual(item.engagement, { stars: 11, forks: 3 });
  assert.match(request?.url ?? "", /updated%3A%3E%3D2026-09-01/);
  const headers = new Headers(request?.init?.headers);
  assert.equal(headers.has("authorization"), false);
  assert.equal(headers.get("user-agent"), "research-pi-research-kit");
  assert.equal(new URL(request?.url ?? GITHUB_REPOSITORY_SEARCH_ENDPOINT).origin, "https://api.github.com");
});

test("schema and rate-limit failures remain source failures, not empty results", async () => {
  const broken = createHackerNewsAdapter({ fetch: async () => response({ unexpected: true }) });
  const limited = createGitHubAdapter({ fetch: async () => response({ message: "rate limit" }, { status: 429, statusText: "Too Many Requests" }) });
  const result = await runRecentResearch(
    { search: async () => ({ results: [] }), fetch: async () => ({}) },
    "fixture",
    { now: new Date("2026-09-20T00:00:00.000Z"), adapters: [broken, limited] },
  );
  assert.equal(result.statuses.find((status) => status.id === "hacker-news")?.errorCode, "schema");
  assert.equal(result.statuses.find((status) => status.id === "github")?.errorCode, "rate_limited");
  assert.equal(result.statuses.find((status) => status.id === "hacker-news")?.status, "failed");
  assert.equal(result.recent.length, 0);
  assert.ok(result.unavailableCoverage.includes("Reddit"));
  assert.ok(result.unavailableCoverage.includes("X"));
  assert.ok(!result.unavailableCoverage.includes("Hacker News"));
  assert.ok(!result.unavailableCoverage.includes("GitHub"));
});

test("source output is bounded and cancellation is not converted to no results", async () => {
  const adapter = createGitHubAdapter({
    maxOutputBytes: 20,
    fetch: async () => new Response("x".repeat(100)),
  });
  await assert.rejects(adapter.search!("large"), (error: unknown) => error instanceof SourceAdapterError && error.code === "output_limit");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(adapter.search!("cancelled", { signal: controller.signal }), /cancel|aborted/i);
});

// A deliberately restricted adapter set must not claim unselected coverage.
test("HN-only registration does not claim other provider coverage", async () => {
  const result = await runRecentResearch({ search: async () => ({ results: [] }), fetch: async () => ({}) }, "coverage", { adapters: [createHackerNewsAdapter({ fetch: async () => new Response(JSON.stringify({ hits: [] })) })] });
  assert.ok(result.unavailableCoverage.includes("Reddit"));
  assert.ok(result.unavailableCoverage.includes("X"));
  assert.ok(result.unavailableCoverage.includes("YouTube"));
  assert.ok(result.unavailableCoverage.includes("Polymarket"));
  assert.ok(!result.unavailableCoverage.includes("Hacker News"));
  assert.equal(HACKER_NEWS_SEARCH_ENDPOINT, "https://hn.algolia.com/api/v1/search_by_date");
});
