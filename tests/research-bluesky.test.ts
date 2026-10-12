import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BLUESKY_CREATE_SESSION_ENDPOINT,
  BLUESKY_SEARCH_POSTS_ENDPOINT,
  createBlueskyAdapter,
  createSocialSourceAdapters,
} from "../src/research/social-sources.ts";
import { SourceAdapterError } from "../src/research/sources.ts";
import { configuredResearchAdapters } from "../src/research/config.ts";
import { runRecentResearch } from "../src/research/research.ts";

const HANDLE = "fixture.bsky.social";
const PASSWORD = "fixture-app-password-SECRET";
const TOKEN_A = "fixture-access-token-A-SECRET";
const TOKEN_B = "fixture-access-token-B-SECRET";
const SECRETS = [PASSWORD, TOKEN_A, TOKEN_B, "refresh-SECRET"];

function response(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, ...init });
}

function session(accessJwt: string): Response {
  return response({ did: "did:plc:fixture", handle: HANDLE, accessJwt, refreshJwt: "refresh-SECRET" });
}

const POSTS = {
  posts: [
    {
      uri: "at://did:plc:author1/app.bsky.feed.post/3kabcxyz",
      cid: "bafy",
      author: { did: "did:plc:author1", handle: "alice.example.com", displayName: "Alice" },
      record: { $type: "app.bsky.feed.post", text: "Agent tooling is moving fast.", createdAt: "2026-09-19T12:00:00.000Z" },
      indexedAt: "2026-09-19T12:00:05.000Z",
      likeCount: 9,
      repostCount: 2,
      replyCount: 3,
    },
    {
      uri: "at://did:plc:author2/app.bsky.feed.post/3kdefuvw",
      author: { did: "did:plc:author2", handle: "handle.invalid" },
      record: { text: "Only an indexed date." },
      indexedAt: "2026-09-18T08:00:00.000Z",
    },
  ],
};

function assertNoSecrets(value: unknown): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!serialized.includes(secret), "secret leaked");
}

test("Bluesky creates a session, searches latest posts, and maps post evidence", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = createBlueskyAdapter({
    handle: HANDLE,
    appPassword: PASSWORD,
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return String(input) === BLUESKY_CREATE_SESSION_ENDPOINT ? session(TOKEN_A) : response(POSTS);
    },
  });
  const result = await adapter.search!("agent tooling", { after: "2026-09-01T00:00:00Z", before: "2026-09-20T00:00:00Z", limit: 80 }) as Array<Record<string, unknown>>;

  assert.equal(requests[0]?.url, BLUESKY_CREATE_SESSION_ENDPOINT);
  assert.equal(requests[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { identifier: HANDLE, password: PASSWORD });
  const search = new URL(requests[1]?.url ?? "");
  assert.equal(`${search.origin}${search.pathname}`, BLUESKY_SEARCH_POSTS_ENDPOINT);
  assert.equal(search.searchParams.get("q"), "agent tooling");
  assert.equal(search.searchParams.get("sort"), "latest");
  assert.equal(search.searchParams.get("limit"), "25");
  assert.equal(search.searchParams.get("since"), "2026-09-01T00:00:00.000Z");
  assert.equal(search.searchParams.get("until"), "2026-09-20T00:00:00.000Z");
  assert.equal(new Headers(requests[1]?.init?.headers).get("authorization"), `Bearer ${TOKEN_A}`);
  assert.equal(requests[1]?.init?.redirect, "error");

  assert.equal(result.length, 2);
  assert.equal(result[0]?.url, "https://bsky.app/profile/alice.example.com/post/3kabcxyz");
  assert.equal(result[0]?.author, "alice.example.com");
  assert.equal(result[0]?.snippet, "Agent tooling is moving fast.");
  assert.equal(result[0]?.publishedAt, "2026-09-19T12:00:00.000Z");
  assert.deepEqual(result[0]?.engagement, { score: 9, comments: 3 });
  assert.equal(result[1]?.url, "https://bsky.app/profile/did%3Aplc%3Aauthor2/post/3kdefuvw");
  assert.equal(result[1]?.publishedAt, "2026-09-18T08:00:00.000Z");
  assertNoSecrets(result);

  await adapter.search!("again");
  assert.equal(requests.filter((request) => request.url === BLUESKY_CREATE_SESSION_ENDPOINT).length, 1, "session is reused in memory");
});

test("Bluesky re-creates the session once when the access token is rejected", async () => {
  let sessions = 0;
  const authorizations: string[] = [];
  const adapter = createBlueskyAdapter({
    handle: HANDLE,
    appPassword: PASSWORD,
    fetch: async (input, init) => {
      if (String(input) === BLUESKY_CREATE_SESSION_ENDPOINT) { sessions += 1; return session(sessions === 1 ? TOKEN_A : TOKEN_B); }
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      authorizations.push(authorization);
      return authorization === `Bearer ${TOKEN_A}` && authorizations.length > 1
        ? response({ error: "ExpiredToken", message: "Token has expired" }, { status: 400, statusText: "Bad Request" })
        : response(POSTS);
    },
  });
  await adapter.search!("first");
  const result = await adapter.search!("second") as unknown[];
  assert.equal(result.length, 2);
  assert.equal(sessions, 2);
  assert.deepEqual(authorizations, [`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]);

  let unauthorizedSessions = 0;
  const unauthorized = createBlueskyAdapter({
    handle: HANDLE,
    appPassword: PASSWORD,
    fetch: async (input) => {
      if (String(input) === BLUESKY_CREATE_SESSION_ENDPOINT) { unauthorizedSessions += 1; return session(TOKEN_A); }
      return response({ error: "AuthenticationRequired", message: `bad ${TOKEN_A}` }, { status: 401, statusText: "Unauthorized" });
    },
  });
  await assert.rejects(unauthorized.search!("q"), (error: unknown) => {
    assert.ok(error instanceof SourceAdapterError);
    assert.equal(error.code, "auth_required");
    assertNoSecrets(error.message);
    return true;
  });
  assert.equal(unauthorizedSessions, 2, "one refresh attempt, then the failure is reported");
});

test("Bluesky auth failures are reported without the password or tokens", async () => {
  let calls = 0;
  const adapter = createBlueskyAdapter({
    handle: HANDLE,
    appPassword: PASSWORD,
    fetch: async (_input, init) => {
      calls += 1;
      return response({ error: "AuthenticationRequired", message: `Invalid identifier or password ${String(init?.body)}` }, { status: 401, statusText: "Unauthorized" });
    },
  });
  const result = await runRecentResearch({ search: async () => [], fetch: async () => ({}) }, "fixture", {
    now: new Date("2026-09-20T00:00:00Z"),
    adapters: [adapter],
  });
  const status = result.statuses.find((entry) => entry.id === "bluesky");
  assert.equal(status?.status, "failed");
  assert.equal(status?.errorCode, "auth_required");
  assert.match(status?.message ?? "", /Bluesky authentication failed \(HTTP 401\)/);
  assertNoSecrets(result);
  assertNoSecrets(adapter);

  await assert.rejects(adapter.search!("retry"), /authentication failed/);
  assert.equal(calls, 2, "a failed session is not cached");

  const network = createBlueskyAdapter({ handle: HANDLE, appPassword: PASSWORD, fetch: async () => { throw new Error(`socket closed ${PASSWORD}`); } });
  await assert.rejects(network.search!("q"), (error: unknown) => {
    assert.ok(error instanceof SourceAdapterError);
    assert.equal(error.cause, undefined);
    assertNoSecrets(error.message);
    return true;
  });
});

test("Bluesky rejects unknown schemas and is unconfigured without credentials", async () => {
  const broken = createBlueskyAdapter({
    handle: HANDLE,
    appPassword: PASSWORD,
    fetch: async (input) => String(input) === BLUESKY_CREATE_SESSION_ENDPOINT ? session(TOKEN_A) : response({ feed: [] }),
  });
  await assert.rejects(broken.search!("q"), (error: unknown) => error instanceof SourceAdapterError && error.code === "schema");
  const badPosts = createBlueskyAdapter({
    handle: HANDLE,
    appPassword: PASSWORD,
    fetch: async (input) => String(input) === BLUESKY_CREATE_SESSION_ENDPOINT ? session(TOKEN_A) : response({ posts: [{ uri: "https://evil.test/x", record: { text: "x", createdAt: "2026-09-19T00:00:00Z" } }] }),
  });
  await assert.rejects(badPosts.search!("q"), (error: unknown) => error instanceof SourceAdapterError && error.code === "schema");
  await assert.rejects(createBlueskyAdapter().search!("q"), (error: unknown) => error instanceof SourceAdapterError && error.code === "auth_required");
});

test("Bluesky is registered only with explicit opt-in and both credentials", () => {
  assert.ok(!createSocialSourceAdapters({ blueskyHandle: HANDLE }).some((adapter) => adapter.id === "bluesky"));
  assert.ok(createSocialSourceAdapters({ blueskyHandle: HANDLE, blueskyAppPassword: PASSWORD }).some((adapter) => adapter.id === "bluesky"));
  const ids = (env: NodeJS.ProcessEnv) => configuredResearchAdapters(env).map((adapter) => adapter.id);
  assert.ok(!ids({ PI_RESEARCH_BLUESKY_HANDLE: HANDLE, PI_RESEARCH_BLUESKY_APP_PASSWORD: PASSWORD, BLUESKY_HANDLE: HANDLE, BLUESKY_APP_PASSWORD: PASSWORD }).includes("bluesky"));
  assert.ok(!ids({ PI_RESEARCH_ENABLE_BLUESKY: "1", PI_RESEARCH_BLUESKY_HANDLE: HANDLE }).includes("bluesky"));
  assert.ok(ids({ PI_RESEARCH_ENABLE_BLUESKY: "1", PI_RESEARCH_BLUESKY_HANDLE: HANDLE, PI_RESEARCH_BLUESKY_APP_PASSWORD: PASSWORD }).includes("bluesky"));
});
