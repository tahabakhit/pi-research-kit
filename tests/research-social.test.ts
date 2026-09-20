import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPolymarketAdapter,
  createRedditAdapter,
  createSocialSourceAdapters,
  createXAdapter,
  createYouTubeAdapter,
  REDDIT_COMMENTS_ENDPOINT,
  YOUTUBE_COMMENT_THREADS_ENDPOINT,
} from "../src/research/social-sources.ts";
import { SourceAdapterError } from "../src/research/sources.ts";
import { runRecentResearch } from "../src/research/research.ts";

function response(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, ...init });
}

test("Reddit public search maps post evidence and bounded request controls", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const adapter = createRedditAdapter({
    fetch: async (input, init) => {
      request = { url: String(input), init };
      return response({ data: { children: [{ data: { id: "abc", title: "Public discussion", permalink: "/r/example/comments/abc/public_discussion/", subreddit: "example", selftext: "A retrieved post body.", created_utc: 1790000000, author: "alice", score: 12, num_comments: 4 } }] } });
    },
  });
  const result = await adapter.search!("public discussion", { after: "2026-09-01T00:00:00.000Z", before: "2026-09-20T00:00:00.000Z", limit: 5 }) as Array<Record<string, unknown>>;
  assert.equal(result[0]?.url, "https://www.reddit.com/r/example/comments/abc/public_discussion/");
  assert.equal(result[0]?.publishedAt, "2026-09-21T14:13:20.000Z");
  assert.deepEqual(result[0]?.engagement, { score: 12, comments: 4 });
  assert.doesNotMatch(request?.url ?? "", /[?&](?:after|before)=/);
  assert.equal(request?.init?.redirect, "error");
});

test("Reddit fetch retrieves canonical post and comment IDs with quotes and metrics", async () => {
  let requestUrl = "";
  const adapter = createRedditAdapter({
    fetch: async (input) => {
      requestUrl = String(input);
      return response([
        { data: { children: [{ data: { id: "abc123", title: "A post", permalink: "/r/example/comments/abc123/a_post/", selftext: "Post evidence", created_utc: 1790000000 } }] } },
        { data: { children: [{ kind: "t1", data: { id: "def456", author: "commenter", body: "An actual comment quote", permalink: "/r/example/comments/abc123/a_post/def456/", created_utc: 1790000060, score: 7, num_comments: 2 } }] } },
      ]);
    },
  });
  const result = await adapter.fetch!("https://www.reddit.com/r/example/comments/abc123/a_post/") as { url: string; comments: Array<Record<string, unknown>>; content: string };
  assert.equal(new URL(requestUrl).origin, new URL(REDDIT_COMMENTS_ENDPOINT).origin);
  assert.match(requestUrl, /\/comments\/abc123\.json/);
  assert.equal(result.url, "https://www.reddit.com/r/example/comments/abc123/a_post/");
  assert.equal(result.comments[0]?.id, "t1_def456");
  assert.equal(result.comments[0]?.author, "commenter");
  assert.match(String(result.comments[0]?.quote), /actual comment quote/);
  assert.deepEqual(result.comments[0]?.engagement, { score: 7, comments: 2 });
  assert.match(result.content, /An actual comment quote/);
});

test("YouTube commentThreads is opt-in and preserves comment dates, authors, quotes, URLs, and metrics", async () => {
  let requestUrl = "";
  const adapter = createYouTubeAdapter({
    apiKey: "fixture-key",
    fetch: async (input) => {
      requestUrl = String(input);
      return response({ items: [{ id: "UgCOMMENT", snippet: { topLevelComment: { id: "UgCOMMENT", snippet: { authorDisplayName: "Viewer", textOriginal: "A useful quote", publishedAt: "2026-09-19T01:02:03Z", likeCount: 4 } }, totalReplyCount: 3 } }] });
    },
  });
  const result = await adapter.fetch!("https://youtu.be/abcdefghijk") as { comments: Array<Record<string, unknown>>; content: string; url: string };
  assert.equal(new URL(requestUrl).origin, new URL(YOUTUBE_COMMENT_THREADS_ENDPOINT).origin);
  assert.equal(new URL(requestUrl).searchParams.get("videoId"), "abcdefghijk");
  assert.equal(result.comments[0]?.author, "Viewer");
  assert.equal(result.comments[0]?.publishedAt, "2026-09-19T01:02:03.000Z");
  assert.equal(result.comments[0]?.url, "https://www.youtube.com/watch?v=abcdefghijk&lc=UgCOMMENT");
  assert.deepEqual(result.comments[0]?.engagement, { score: 4, comments: 3 });
  assert.match(result.content, /A useful quote/);
  await assert.rejects(createYouTubeAdapter().fetch!("https://www.youtube.com/watch?v=abcdefghijk"), /disabled|key|required/i);
});

test("Polymarket Gamma keeps market end dates distinct from publication dates", async () => {
  const adapter = createPolymarketAdapter({
    fetch: async () => response({ markets: [
      { id: "m1", slug: "will-example-happen", question: "Will example happen?", description: "A market fixture.", endDate: "2026-12-31T00:00:00Z" },
      { id: "m2", slug: "created-market", question: "Created market", createdAt: "2026-09-19T00:00:00Z", endDate: "2026-10-01T00:00:00Z" },
    ] }),
  });
  const result = await adapter.search!("example") as Array<Record<string, unknown>>;
  assert.equal(result.length, 2);
  assert.equal(result[0]?.publishedAt, null);
  assert.match(String(result[0]?.snippet), /end date \(not publication date\)/);
  assert.equal(result[1]?.publishedAt, "2026-09-19T00:00:00.000Z");
});

test("X uses only explicit credentials and reports recent-search partial coverage", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const adapter = createXAdapter({
    bearerToken: "fixture-token",
    now: () => new Date("2026-09-20T00:01:00Z"),
    fetch: async (input, init) => {
      request = { url: String(input), init };
      return response({ data: [{ id: "tweet-1", text: "A recent post", author_id: "user-1", created_at: "2026-09-19T12:00:00Z" }], includes: { users: [{ id: "user-1", username: "alice" }] } });
    },
  });
  const result = await adapter.search!("recent post", { after: "2026-08-01T00:00:00Z", before: "2026-09-20T00:00:00Z", limit: 5 }) as Array<Record<string, unknown>> & { sourceMetadata?: { partial?: boolean; message: string } };
  assert.equal(result[0]?.author, "alice");
  assert.equal(result.sourceMetadata?.partial, true);
  assert.match(result.sourceMetadata?.message ?? "", /last 7 days/);
  const headers = new Headers(request?.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer fixture-token");
  assert.match(new URL(request?.url ?? "https://api.x.com").searchParams.get("start_time") ?? "", /2026-09-13/);
});

test("YouTube returns metadata-only evidence and credentialed adapters are opt-in", async () => {
  let requestUrl = "";
  const adapter = createYouTubeAdapter({
    apiKey: "fixture-key",
    fetch: async (input) => {
      requestUrl = String(input);
      return response({ items: [{ id: { kind: "youtube#video", videoId: "video-1" }, snippet: { title: "A video", description: "Description", publishedAt: "2026-09-19T00:00:00Z", channelTitle: "Fixture channel" } }] });
    },
  });
  const result = await adapter.search!("video") as Array<Record<string, unknown>>;
  assert.match(String(result[0]?.snippet), /metadata only/);
  assert.doesNotMatch(String(result[0]?.snippet), /transcript retrieved/);
  assert.equal(result[0]?.author, "Fixture channel");
  assert.equal(new URL(requestUrl).searchParams.get("key"), "fixture-key");
  assert.deepEqual(createSocialSourceAdapters().map((source) => source.id), ["reddit", "polymarket"]);
  assert.deepEqual(createSocialSourceAdapters({ xBearerToken: "x", youtubeApiKey: "y" }).map((source) => source.id), ["reddit", "polymarket", "x", "youtube"]);
});

test("social source HTTP and schema failures remain visible to research statuses", async () => {
  const broken = createRedditAdapter({ fetch: async () => response({ nope: true }) });
  const limited = createPolymarketAdapter({ fetch: async () => response({ error: "slow down" }, { status: 429, statusText: "Too Many Requests" }) });
  const result = await runRecentResearch({ search: async () => [], fetch: async () => ({}) }, "fixture", {
    now: new Date("2026-09-20T00:00:00Z"),
    adapters: [broken, limited],
  });
  assert.equal(result.statuses.find((status) => status.id === "reddit")?.errorCode, "schema");
  assert.equal(result.statuses.find((status) => status.id === "polymarket")?.errorCode, "rate_limited");
  await assert.rejects(createYouTubeAdapter().search!("unconfigured"), (error: unknown) => error instanceof SourceAdapterError && error.code === "auth_required");
});
