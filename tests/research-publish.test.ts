import assert from "node:assert/strict";
import { test } from "node:test";
import type { LibraryRecord } from "../src/research/types.ts";
import { authorizePublication, getPublicationPreview, publishResearch } from "../src/research/publication.ts";
import { createGitHubPublication, type GitHubFetch, type GitHubPublicationConfig } from "../src/research/github-publish.ts";

const config: GitHubPublicationConfig = {
  owner: "research-owner",
  repo: "research-pages",
  branch: "main",
  token: "ghs-test-secret",
  pathPrefix: "published/research",
};

const record: LibraryRecord = {
  id: "record-1",
  title: "<script>alert(1)</script>",
  summary: "<unsafe & summary>",
  content: "<b>unsafe</b>",
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  evidence: [{
    id: "evidence-1",
    title: "Source <one>",
    url: "https://example.test/source?a=1&b=2",
    source: "fixture",
    snippet: "snippet",
    publishedAt: null,
    retrievedAt: "2026-09-20T00:00:00.000Z",
    citation: { id: "citation-1", title: "Source <one>", url: "https://example.test/source", source: "fixture", publishedAt: null },
    provenance: { kind: "fetch", adapter: "fixture" },
    confidence: 0.9,
  }],
  coverage: ["<not covered>"],
};

function response(value: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function fixtureFetch(options: { existing?: string[]; conflict?: boolean; error?: boolean } = {}): { fetch: GitHubFetch; calls: { url: string; init?: Parameters<GitHubFetch>[1] }[] } {
  const calls: { url: string; init?: Parameters<GitHubFetch>[1] }[] = [];
  const baseSha = "1111111111111111111111111111111111111111";
  const fetch: GitHubFetch = async (url, init) => {
    calls.push({ url, init });
    if (options.error) return response({ message: `token=${config.token}` }, 403);
    if (init?.method === "POST" && url.endsWith("/git/blobs")) return response({ sha: "2222222222222222222222222222222222222222" });
    if (init?.method === "POST" && url.endsWith("/git/trees")) return response({ sha: "3333333333333333333333333333333333333333" });
    if (init?.method === "POST" && url.endsWith("/git/commits")) return response({ sha: "4444444444444444444444444444444444444444" });
    if (init?.method === "PATCH") return response({}, 200);
    if (url.includes("/git/ref/heads/")) return response({ object: { sha: options.conflict && calls.length > 7 ? "5555555555555555555555555555555555555555" : baseSha } });
    if (url.includes("/git/commits/")) return response({ tree: { sha: "6666666666666666666666666666666666666666" } });
    if (url.includes("/git/trees/")) return response({ tree: (options.existing ?? []).map((path) => ({ path, type: "blob", sha: baseSha })) });
    throw new Error(`unexpected fixture request: ${url}`);
  };
  return { fetch, calls };
}

function makeContract(options: Parameters<typeof fixtureFetch>[0] = {}) {
  const fixture = fixtureFetch(options);
  return { contract: createGitHubPublication(config, { fetch: fixture.fetch }), calls: fixture.calls };
}

test("missing explicit GitHub configuration is rejected without guessing", () => {
  assert.throws(() => createGitHubPublication({ ...config, token: "" }), /explicitly supplied token/);
  assert.throws(() => createGitHubPublication({ ...config, pathPrefix: "../private" }), /path prefix/);
});

test("wrapper makes no request until exact human-bound preview authorization", async () => {
  const { contract, calls } = makeContract();
  const rejected = await publishResearch(record, contract, { approved: true });
  assert.equal(rejected.status, "failed");
  assert.equal(calls.length, 0);

  const preview = getPublicationPreview(record, contract)!;
  assert.equal(preview.destination, "https://github.com/research-owner/research-pages/tree/main/published/research/record-1");
  assert.match(preview.contentHash, /^[a-f0-9]{64}$/);
  const authorization = authorizePublication(preview);
  const authorized = await publishResearch(record, contract, { approved: true, authorization });
  assert.equal(authorized.status, "published");
  assert.equal(calls.at(-1)?.init?.method, "PATCH");
  assert.match(authorized.reference ?? "", /\/commit\/4444/);
  const requestCount = calls.length;
  const replay = await publishResearch(record, contract, { authorization });
  assert.equal(replay.status, "failed");
  assert.equal(calls.length, requestCount);
});

test("publishes escaped HTML, Atom, and Markdown artifacts under immutable prefix", async () => {
  const { contract, calls } = makeContract();
  const preview = getPublicationPreview(record, contract)!;
  const result = await publishResearch(record, contract, { authorization: authorizePublication(preview) });
  assert.equal(result.status, "published");
  const blobBodies = calls.filter((call) => call.init?.method === "POST" && call.url.endsWith("/git/blobs")).map((call) => JSON.parse(call.init?.body ?? "{}") as { content: string });
  assert.equal(blobBodies.length, 3);
  assert.ok(blobBodies.some(({ content }) => content.includes("&lt;script&gt;") && !content.includes("<script>")));
  assert.ok(blobBodies.some(({ content }) => content.includes("<?xml version") && content.includes("&lt;b&gt;unsafe")));
  assert.ok(blobBodies.some(({ content }) => content.includes("&lt;unsafe &amp; summary&gt;")));
  const treeCall = calls.find((call) => call.init?.method === "POST" && call.url.endsWith("/git/trees"));
  const treeBody = JSON.parse(treeCall?.init?.body ?? "{}") as { base_tree: string; tree: { path: string; mode: string; type: string }[] };
  assert.equal(treeBody.base_tree, "6666666666666666666666666666666666666666");
  assert.deepEqual(treeBody.tree.map((entry) => entry.path), [
    "published/research/record-1/index.html",
    "published/research/record-1/atom.xml",
    "published/research/record-1/record.md",
  ]);
  assert.ok(treeBody.tree.every((entry) => entry.mode === "100644" && entry.type === "blob"));
});

test("existing destinations and branch races fail without ref overwrite", async () => {
  const collision = makeContract({ existing: ["published/research/record-1/record.md"] });
  const preview = getPublicationPreview(record, collision.contract)!;
  const result = await publishResearch(record, collision.contract, { authorization: authorizePublication(preview) });
  assert.equal(result.status, "failed");
  assert.match(result.message, /already exists/);
  assert.equal(collision.calls.some((call) => call.init?.method === "PATCH"), false);

  const conflict = makeContract({ conflict: true });
  const conflictPreview = getPublicationPreview(record, conflict.contract)!;
  const conflictResult = await publishResearch(record, conflict.contract, { authorization: authorizePublication(conflictPreview) });
  assert.equal(conflictResult.status, "failed");
  assert.match(conflictResult.message, /conflict/i);
  assert.equal(conflict.calls.some((call) => call.init?.method === "PATCH"), false);
});

test("HTTP failures are bounded and redact the explicit token", async () => {
  const { contract, calls } = makeContract({ error: true });
  const preview = getPublicationPreview(record, contract)!;
  const result = await publishResearch(record, contract, { authorization: authorizePublication(preview) });
  assert.equal(result.status, "failed");
  assert.match(result.message, /403/);
  assert.doesNotMatch(result.message, new RegExp(config.token));
  assert.equal(calls.length, 1);
});
