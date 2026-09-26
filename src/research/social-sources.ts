import type { SearchOptions, SourceAdapter } from "./types.ts";
import { fetchSourceJson, SOURCE_MAX_RESULTS, type SourceAdapterOptions, SourceAdapterError } from "./sources.ts";

export const REDDIT_SEARCH_ENDPOINT = "https://www.reddit.com/search.json";
export const REDDIT_COMMENTS_ENDPOINT = "https://www.reddit.com/comments";
export const POLYMARKET_PUBLIC_SEARCH_ENDPOINT = "https://gamma-api.polymarket.com/public-search";
export const X_RECENT_SEARCH_ENDPOINT = "https://api.x.com/2/tweets/search/recent";
export const YOUTUBE_SEARCH_ENDPOINT = "https://www.googleapis.com/youtube/v3/search";
export const YOUTUBE_COMMENT_THREADS_ENDPOINT = "https://www.googleapis.com/youtube/v3/commentThreads";
export const BLUESKY_CREATE_SESSION_ENDPOINT = "https://bsky.social/xrpc/com.atproto.server.createSession";
export const BLUESKY_SEARCH_POSTS_ENDPOINT = "https://bsky.social/xrpc/app.bsky.feed.searchPosts";
const BLUESKY_MAX_RESULTS = 25;
const X_RECENT_WINDOW_MS = 7 * 86_400_000;

type RecordValue = Record<string, unknown>;

export interface SocialSourceAdapterOptions extends SourceAdapterOptions {
  /** Explicit operator-supplied X bearer token. It is never read from process.env. */
  xBearerToken?: string;
  /** Explicit operator-supplied YouTube Data API key. It is never read from process.env. */
  youtubeApiKey?: string;
  /** Explicit operator-supplied Bluesky handle. It is never read from process.env. */
  blueskyHandle?: string;
  /** Explicit operator-supplied Bluesky app password. It is never read from process.env. */
  blueskyAppPassword?: string;
}

export interface SourceCoverageMetadata {
  partial?: boolean;
  message: string;
}

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function date(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function dateOption(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function limit(options?: SearchOptions): number {
  const value = options?.limit;
  return Number.isInteger(value) && value && value > 0 ? Math.min(value, SOURCE_MAX_RESULTS) : SOURCE_MAX_RESULTS;
}

function safeHttpsUrl(value: unknown): string | undefined {
  const input = text(value);
  if (!input) return undefined;
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) return undefined;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function redditUrl(value: unknown): string | undefined {
  const url = safeHttpsUrl(value);
  if (!url || new URL(url).hostname !== "www.reddit.com") return undefined;
  return url;
}

function redditPostId(value: string): string | undefined {
  const input = value.trim();
  if (/^t3_[A-Za-z0-9]+$/.test(input)) return input.slice(3);
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.hostname !== "www.reddit.com") return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    const comments = parts.findIndex((part) => part.toLowerCase() === "comments");
    const candidate = comments >= 0 ? parts[comments + 1] : undefined;
    return candidate && /^[A-Za-z0-9]+$/.test(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function redditCommentUrl(value: unknown, postUrl: string): string | undefined {
  const input = text(value);
  if (input?.startsWith("/")) return redditUrl(`https://www.reddit.com${input}`);
  const direct = redditUrl(input);
  if (direct) return direct;
  return input && /^[A-Za-z0-9]+$/.test(input) ? `${postUrl.replace(/\/$/, "")}/?comment=${encodeURIComponent(input)}` : undefined;
}

function youtubeVideoId(value: string): string | undefined {
  const input = value.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || !["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"].includes(url.hostname)) return undefined;
    if (url.hostname === "youtu.be") return /^[A-Za-z0-9_-]{11}$/.test(url.pathname.slice(1)) ? url.pathname.slice(1) : undefined;
    const queryId = url.searchParams.get("v");
    if (queryId && /^[A-Za-z0-9_-]{11}$/.test(queryId)) return queryId;
    const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function withCoverage(items: RecordValue[], metadata?: SourceCoverageMetadata): RecordValue[] {
  if (metadata) Object.defineProperty(items, "sourceMetadata", { value: metadata, enumerable: false });
  return items;
}

function unixSeconds(value: string | undefined): string | undefined {
  const parsed = dateOption(value);
  return parsed ? String(Math.floor(parsed.getTime() / 1000)) : undefined;
}

function redditSearchUrl(query: string, options?: SearchOptions): string {
  const url = new URL(REDDIT_SEARCH_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("restrict_sr", "off");
  url.searchParams.set("sort", "relevance");
  url.searchParams.set("t", "all");
  url.searchParams.set("limit", String(limit(options)));
  url.searchParams.set("raw_json", "1");
  // Reddit's after/before parameters are pagination fullnames, not timestamps.
  // Dates are filtered by the evidence pipeline; this bounded listing is partial.
  return url.toString();
}

function normalizeReddit(value: unknown): RecordValue[] {
  const payload = record(value);
  const data = payload && record(payload.data);
  if (!data || !Array.isArray(data.children)) throw new SourceAdapterError("Reddit returned an unknown response schema.", "schema");
  const items: RecordValue[] = [];
  for (const child of data.children) {
    const post = record(record(child)?.data);
    if (!post) continue;
    const rawId = text(post.id) ?? text(post.name);
    const id = rawId?.replace(/^t3_/, "");
    const permalink = text(post.permalink);
    if (!id || !permalink) continue;
    const url = redditUrl(permalink.startsWith("http") ? permalink : `https://www.reddit.com${permalink}`);
    const title = text(post.title);
    const createdAt = typeof post.created_utc === "number" ? date(post.created_utc * 1000) : date(post.created_utc);
    if (!url || !title || !createdAt) continue;
    const subreddit = text(post.subreddit);
    const body = text(post.selftext);
    const snippet = body ? `${subreddit ? `r/${subreddit}: ` : ""}${body}` : `Reddit post${subreddit ? ` in r/${subreddit}` : ""}: ${title}`;
    const score = nonNegativeNumber(post.score);
    const comments = nonNegativeNumber(post.num_comments);
    items.push({
      id: `t3_${id}`,
      title,
      url,
      snippet,
      publishedAt: createdAt,
      dateKind: "submission",
      ...(text(post.author) && text(post.author) !== "[deleted]" ? { author: text(post.author) } : {}),
      ...((score !== undefined || comments !== undefined) ? { engagement: { ...(score !== undefined ? { score } : {}), ...(comments !== undefined ? { comments } : {}) } } : {}),
    });
  }
  if (data.children.length > 0 && items.length === 0) throw new SourceAdapterError("Reddit returned no records matching its documented schema.", "schema");
  return items;
}

interface RedditComment {
  id: string;
  author?: string;
  quote: string;
  url: string;
  publishedAt: string;
  engagement?: { score?: number; comments?: number };
}

interface RedditFetchResult {
  title: string;
  url: string;
  content: string;
  publishedAt: string | null;
  dateKind: "submission";
  comments: RedditComment[];
  commentsStatus: "available" | "empty";
}

function normalizeRedditFetch(value: unknown, postId: string): RedditFetchResult {
  if (!Array.isArray(value) || value.length < 2) throw new SourceAdapterError("Reddit comments returned an unknown response schema.", "schema");
  const listing = record(value[0]);
  const listingData = listing && record(listing.data);
  const postChild = listingData && Array.isArray(listingData.children) ? record(listingData.children[0]) : null;
  const post = record(postChild?.data);
  if (!post || text(post.id) !== postId || !text(post.title)) throw new SourceAdapterError("Reddit post listing is malformed or does not match the requested post.", "schema");
  const permalink = text(post?.permalink);
  const postUrl = redditUrl(permalink?.startsWith("/") ? `https://www.reddit.com${permalink}` : permalink) ?? `https://www.reddit.com/comments/${encodeURIComponent(postId)}/`;
  const title = text(post?.title) ?? `Reddit post ${postId}`;
  const postBody = text(post?.selftext) ?? "(No post body.)";
  const postDate = typeof post?.created_utc === "number" ? date(post.created_utc * 1000) : date(post?.created_utc);
  const commentsListing = record(value[1]);
  const commentsData = commentsListing && record(commentsListing.data);
  if (!commentsData || !Array.isArray(commentsData.children)) throw new SourceAdapterError("Reddit comment listing is malformed.", "schema");
  const rawComments = commentsData.children;
  const comments: RedditComment[] = [];
  for (const child of rawComments) {
    const comment = record(record(child)?.data);
    const id = text(comment?.id);
    const quote = text(comment?.body);
    const createdAt = typeof comment?.created_utc === "number" ? date(comment.created_utc * 1000) : date(comment?.created_utc);
    if (!id || !quote || !createdAt || quote === "[deleted]") continue;
    const url = redditCommentUrl(comment?.permalink, postUrl) ?? `${postUrl.replace(/\/$/, "")}/?comment=${encodeURIComponent(id)}`;
    const score = nonNegativeNumber(comment?.score);
    const replies = nonNegativeNumber(comment?.num_comments);
    comments.push({ id: `t1_${id}`, ...(text(comment?.author) && text(comment?.author) !== "[deleted]" ? { author: text(comment?.author) } : {}), quote, url, publishedAt: createdAt, ...((score !== undefined || replies !== undefined) ? { engagement: { ...(score !== undefined ? { score } : {}), ...(replies !== undefined ? { comments: replies } : {}) } } : {}) });
  }
  if (rawComments.length > 0 && comments.length === 0) throw new SourceAdapterError("Reddit returned only unusable, deleted, or unexpanded comments; coverage is unavailable, not empty.", "schema");
  const commentText = comments.length === 0 ? "The valid public Reddit listing contained zero comments (bounded coverage)." : comments.map((comment) => `${comment.author ?? "[deleted author]"} (${comment.publishedAt}): ${comment.quote} [${comment.url}]`).join("\n");
  return { title, url: postUrl, content: `${postBody}\n\nComments (${comments.length}):\n${commentText}`, publishedAt: postDate ?? null, dateKind: "submission", comments, commentsStatus: comments.length ? "available" : "empty" };
}

export function createRedditAdapter(options: SourceAdapterOptions = {}): SourceAdapter {
  return {
    id: "reddit",
    label: "Reddit (public search and post comments)",
    capabilities: ["search", "fetch"],
    async search(query, searchOptions = {}) {
      const items = normalizeReddit(await fetchSourceJson(redditSearchUrl(query, searchOptions), { headers: { accept: "application/json", "user-agent": "pi-research-kit/0.1" } }, { ...options, ...searchOptions }));
      return withCoverage(items, { partial: true, message: "Bounded public Reddit listing, filtered locally by publication date; complete historical search and comment trees were not retrieved." });
    },
    async fetch(url, fetchOptions = {}) {
      const postId = redditPostId(url);
      if (!postId) throw new SourceAdapterError("Reddit fetch requires a canonical HTTPS post URL or t3 post ID.", "schema");
      const endpoint = new URL(`${REDDIT_COMMENTS_ENDPOINT}/${encodeURIComponent(postId)}.json`);
      endpoint.searchParams.set("raw_json", "1");
      endpoint.searchParams.set("limit", "50");
      endpoint.searchParams.set("depth", "1");
      const result = normalizeRedditFetch(await fetchSourceJson(endpoint.toString(), { headers: { accept: "application/json", "user-agent": "pi-research-kit/0.1" } }, { ...options, ...fetchOptions } as SourceAdapterOptions & SearchOptions), postId);
      return result;
    },
  };
}

interface PolymarketCandidate {
  value: RecordValue;
  event?: RecordValue;
}

function polymarketCandidates(value: unknown): PolymarketCandidate[] {
  if (Array.isArray(value)) return value.map((item) => record(item)).filter((item): item is RecordValue => item !== null).map((item) => ({ value: item }));
  const payload = record(value);
  if (!payload) return [];
  const candidates: PolymarketCandidate[] = [];
  const markets = payload.markets;
  if (Array.isArray(markets)) {
    for (const market of markets) if (record(market)) candidates.push({ value: market as RecordValue });
  }
  const data = payload.data;
  if (Array.isArray(data)) {
    for (const item of data) if (record(item)) candidates.push({ value: item as RecordValue });
  }
  const events = payload.events;
  if (Array.isArray(events)) {
    for (const eventValue of events) {
      const event = record(eventValue);
      if (!event) continue;
      if (Array.isArray(event.markets)) {
        for (const market of event.markets) { const item = record(market); if (item) candidates.push({ value: item, event }); }
      } else if (text(event.slug) || text(event.title) || text(event.name)) candidates.push({ value: event, event });
    }
  }
  return candidates;
}

function normalizePolymarket(value: unknown): RecordValue[] {
  const candidates = polymarketCandidates(value);
  const payload = record(value);
  const hasRecognizedCollection = Array.isArray(value) || Boolean(payload && (Array.isArray(payload.markets) || Array.isArray(payload.events) || Array.isArray(payload.data)));
  if (!hasRecognizedCollection) throw new SourceAdapterError("Polymarket Gamma returned an unknown response schema.", "schema");
  const items: RecordValue[] = [];
  for (const candidate of candidates) {
    const market = candidate.value;
    const event = candidate.event;
    const title = text(market.question) ?? text(market.title) ?? text(market.name) ?? text(event?.title) ?? text(event?.name);
    const slug = text(event?.slug) ?? text(market.slug);
    const id = text(market.id) ?? text(market.conditionId) ?? slug;
    if (!title || !id) continue;
    const url = safeHttpsUrl(market.url) ?? (slug ? `https://polymarket.com/event/${encodeURIComponent(slug)}` : undefined);
    if (!url) continue;
    const description = text(market.description) ?? text(event?.description);
    const endDate = date(market.endDate ?? market.end_date ?? market.endTime ?? market.end_time);
    const createdAt = date(market.createdAt ?? market.created_at ?? market.creationDate ?? market.creation_date);
    const endNote = endDate ? ` Market end date (not publication date): ${endDate}.` : " Market end date was not supplied.";
    items.push({ title, url, snippet: `${description ?? "Polymarket public market evidence."}${endNote}`, publishedAt: createdAt ?? null, dateKind: "market-created" });
  }
  if (candidates.length > 0 && items.length === 0) throw new SourceAdapterError("Polymarket Gamma returned no records matching its documented market schema.", "schema");
  return items;
}

export function createPolymarketAdapter(options: SourceAdapterOptions = {}): SourceAdapter {
  return {
    id: "polymarket",
    label: "Polymarket (Gamma public market search)",
    capabilities: ["search"],
    async search(query, searchOptions = {}) {
      const url = new URL(POLYMARKET_PUBLIC_SEARCH_ENDPOINT);
      url.searchParams.set("q", query);
      url.searchParams.set("limit_per_type", String(limit(searchOptions)));
      const result = normalizePolymarket(await fetchSourceJson(url.toString(), { headers: { accept: "application/json" } }, { ...options, ...searchOptions }));
      return result;
    },
  };
}

function xWindow(options: SearchOptions, now: Date): { start: Date; end: Date; partial: boolean } {
  const latest = new Date(now.getTime() - 30_000);
  const requestedEnd = dateOption(options.before) ?? latest;
  const end = requestedEnd > latest ? latest : requestedEnd;
  const requestedStart = dateOption(options.after);
  const minimumStart = new Date(now.getTime() - X_RECENT_WINDOW_MS + 30_000);
  if (end <= minimumStart) throw new SourceAdapterError("X recent search cannot cover this historical window; only the last 7 days are supported.", "network");
  const partial = Boolean(requestedStart && requestedStart < minimumStart);
  const start = partial ? minimumStart : requestedStart ?? minimumStart;
  if (start >= end) throw new SourceAdapterError("X recent-search date window is empty.", "schema");
  return { start, end, partial };
}

function normalizeX(value: unknown): RecordValue[] {
  const payload = record(value);
  if (!payload || (!Array.isArray(payload.data) && record(payload.meta)?.result_count !== 0) || payload.errors !== undefined) throw new SourceAdapterError("X returned an unknown or partial-error response schema.", "schema");
  const data = Array.isArray(payload.data) ? payload.data : [];
  const includes = record(payload.includes);
  const users = Array.isArray(includes?.users) ? includes.users : [];
  const usersById = new Map<string, RecordValue>();
  for (const user of users) {
    const item = record(user);
    const id = text(item?.id);
    if (id && item) usersById.set(id, item);
  }
  const items: RecordValue[] = [];
  for (const raw of data) {
    const tweet = record(raw);
    const id = text(tweet?.id);
    const tweetText = text(tweet?.text);
    const createdAt = date(tweet?.created_at);
    if (!id || !tweetText || !createdAt) continue;
    const user = usersById.get(text(tweet?.author_id) ?? "");
    items.push({ title: `X post by ${text(user?.username) ? `@${text(user?.username)}` : "an account"}`, url: `https://x.com/i/status/${encodeURIComponent(id)}`, snippet: tweetText, publishedAt: createdAt, ...(text(user?.username) ? { author: text(user?.username) } : {}) });
  }
  if (data.length > 0 && items.length === 0) throw new SourceAdapterError("X returned no records matching its documented schema.", "schema");
  return items;
}

export interface XAdapterOptions extends SourceAdapterOptions {
  bearerToken?: string;
  now?: () => Date;
}

export function createXAdapter(options: XAdapterOptions = {}): SourceAdapter {
  return {
    id: "x",
    label: "X (official API recent search)",
    capabilities: ["search"],
    async search(query, searchOptions = {}) {
      const token = options.bearerToken?.trim();
      if (!token) throw new SourceAdapterError("X official API is unconfigured; an explicit bearer token is required.", "auth_required");
      const window = xWindow(searchOptions, options.now?.() ?? new Date());
      const url = new URL(X_RECENT_SEARCH_ENDPOINT);
      url.searchParams.set("query", query);
      url.searchParams.set("max_results", String(Math.max(10, limit(searchOptions))));
      url.searchParams.set("start_time", window.start.toISOString());
      url.searchParams.set("end_time", window.end.toISOString());
      url.searchParams.set("tweet.fields", "created_at,author_id");
      url.searchParams.set("expansions", "author_id");
      url.searchParams.set("user.fields", "username,name");
      const result = normalizeX(await fetchSourceJson(url.toString(), { headers: { accept: "application/json", authorization: `Bearer ${token}` } }, { ...options, ...searchOptions }));
      return withCoverage(result, window.partial ? { partial: true, message: "Partial coverage: X recent search only covers the last 7 days; older requested dates were not queried." } : undefined);
    },
  };
}

export interface YouTubeAdapterOptions extends SourceAdapterOptions {
  /** Explicit operator-supplied Data API key; never inferred from environment. */
  apiKey?: string;
}

interface YouTubeComment {
  id: string;
  author?: string;
  quote: string;
  url: string;
  publishedAt: string;
  updatedAt?: string;
  engagement?: { score?: number; comments?: number };
}

interface YouTubeCommentsFetchResult {
  title: string;
  url: string;
  content: string;
  publishedAt: string | null;
  comments: YouTubeComment[];
  commentsStatus: "available" | "empty";
}

function normalizeYouTubeComments(value: unknown, videoId: string): YouTubeCommentsFetchResult {
  const payload = record(value);
  if (!payload || !Array.isArray(payload.items)) throw new SourceAdapterError("YouTube commentThreads returned an unknown response schema.", "schema");
  const videoUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const comments: YouTubeComment[] = [];
  for (const raw of payload.items) {
    const item = record(raw);
    const topLevelComment = record(record(item?.snippet)?.topLevelComment);
    const id = text(topLevelComment?.id);
    const snippet = topLevelComment?.snippet;
    const comment = record(snippet);
    const quote = text(comment?.textOriginal) ?? text(comment?.textDisplay);
    const author = text(comment?.authorDisplayName);
    const publishedAt = date(comment?.publishedAt);
    if (!id || !quote || !publishedAt) continue;
    const updatedAt = date(comment?.updatedAt);
    const likes = nonNegativeNumber(comment?.likeCount);
    const replies = nonNegativeNumber(record(item?.snippet)?.totalReplyCount);
    comments.push({ id, ...(author ? { author } : {}), quote, url: `${videoUrl}&lc=${encodeURIComponent(id)}`, publishedAt, ...(updatedAt ? { updatedAt } : {}), ...((likes !== undefined || replies !== undefined) ? { engagement: { ...(likes !== undefined ? { score: likes } : {}), ...(replies !== undefined ? { comments: replies } : {}) } } : {}) });
  }
  if (payload.items.length > 0 && comments.length === 0) throw new SourceAdapterError("YouTube returned no schema-valid comments; coverage is unavailable, not empty.", "schema");
  const content = comments.length === 0
    ? "The valid YouTube commentThreads response contained zero comments (bounded coverage)."
    : comments.map((comment) => `${comment.author ?? "[unknown author]"} (${comment.publishedAt}): ${comment.quote} [${comment.url}]`).join("\n");
  return { title: `YouTube comments for ${videoUrl}`, url: videoUrl, content, publishedAt: null, comments, commentsStatus: comments.length ? "available" : "empty" };
}

function normalizeYouTube(value: unknown): RecordValue[] {
  const payload = record(value);
  if (!payload || !Array.isArray(payload.items)) throw new SourceAdapterError("YouTube Data API returned an unknown response schema.", "schema");
  const items: RecordValue[] = [];
  for (const raw of payload.items) {
    const item = record(raw);
    const id = record(item?.id);
    const snippet = record(item?.snippet);
    const videoId = text(id?.videoId);
    const title = text(snippet?.title);
    const publishedAt = date(snippet?.publishedAt);
    if (!videoId || !title || !publishedAt) continue;
    items.push({ title, url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, snippet: `YouTube metadata only (no transcript or comments retrieved). ${text(snippet?.description) ?? ""}`.trim(), publishedAt, ...(text(snippet?.channelTitle) ? { author: text(snippet?.channelTitle) } : {}) });
  }
  if (payload.items.length > 0 && items.length === 0) throw new SourceAdapterError("YouTube Data API returned no records matching its documented video schema.", "schema");
  return items;
}

export function createYouTubeAdapter(options: YouTubeAdapterOptions = {}): SourceAdapter {
  return {
    id: "youtube",
    label: "YouTube (official Data API metadata and comments)",
    capabilities: ["search", "fetch"],
    async search(query, searchOptions = {}) {
      const key = options.apiKey?.trim();
      if (!key) throw new SourceAdapterError("YouTube Data API is unconfigured; an explicit API key is required.", "auth_required");
      const url = new URL(YOUTUBE_SEARCH_ENDPOINT);
      url.searchParams.set("part", "snippet");
      url.searchParams.set("type", "video");
      url.searchParams.set("q", query);
      url.searchParams.set("maxResults", String(limit(searchOptions)));
      if (searchOptions.after) url.searchParams.set("publishedAfter", searchOptions.after);
      if (searchOptions.before) url.searchParams.set("publishedBefore", searchOptions.before);
      url.searchParams.set("key", key);
      return normalizeYouTube(await fetchSourceJson(url.toString(), { headers: { accept: "application/json" } }, { ...options, ...searchOptions }));
    },
    async fetch(videoUrl, fetchOptions = {}) {
      const videoId = youtubeVideoId(videoUrl);
      const key = options.apiKey?.trim();
      if (!videoId) throw new SourceAdapterError("YouTube comment fetch requires a canonical HTTPS video URL or 11-character video ID.", "schema");
      if (!key) throw new SourceAdapterError("YouTube comments are disabled; an explicit YouTube Data API key is required.", "auth_required");
      const url = new URL(YOUTUBE_COMMENT_THREADS_ENDPOINT);
      url.searchParams.set("part", "snippet,replies");
      url.searchParams.set("videoId", videoId);
      url.searchParams.set("maxResults", "100");
      url.searchParams.set("key", key);
      return normalizeYouTubeComments(await fetchSourceJson(url.toString(), { headers: { accept: "application/json" } }, { ...options, ...fetchOptions } as SourceAdapterOptions & SearchOptions), videoId);
    },
  };
}

export interface BlueskyAdapterOptions extends SourceAdapterOptions {
  /** Explicit operator-supplied handle or DID used as the session identifier. */
  handle?: string;
  /** Explicit operator-supplied app password; sent only to createSession. */
  appPassword?: string;
}

function blueskyPostUrl(uri: unknown, author: RecordValue | null): string | undefined {
  const match = text(uri)?.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._:~-]{1,512})$/);
  if (!match) return undefined;
  const handle = text(author?.handle);
  const did = text(author?.did) ?? match[1];
  const actor = handle && handle !== "handle.invalid" && /^[A-Za-z0-9.-]+$/.test(handle) ? handle : did;
  if (!actor || !/^[A-Za-z0-9.:_-]+$/.test(actor)) return undefined;
  return `https://bsky.app/profile/${encodeURIComponent(actor)}/post/${encodeURIComponent(match[2] as string)}`;
}

function normalizeBluesky(value: unknown): RecordValue[] {
  const payload = record(value);
  if (!payload || !Array.isArray(payload.posts)) throw new SourceAdapterError("Bluesky returned an unknown response schema.", "schema");
  const items: RecordValue[] = [];
  for (const raw of payload.posts) {
    const post = record(raw);
    const author = record(post?.author);
    const postRecord = record(post?.record);
    const url = blueskyPostUrl(post?.uri, author);
    const postText = text(postRecord?.text);
    const publishedAt = date(postRecord?.createdAt) ?? date(post?.indexedAt);
    if (!url || !postText || !publishedAt) continue;
    const handle = text(author?.handle);
    const likes = nonNegativeNumber(post?.likeCount);
    const replies = nonNegativeNumber(post?.replyCount);
    items.push({
      title: `Bluesky post by ${handle ? `@${handle}` : "an account"}`,
      url,
      snippet: postText,
      publishedAt,
      ...(handle ? { author: handle } : {}),
      ...((likes !== undefined || replies !== undefined) ? { engagement: { ...(likes !== undefined ? { score: likes } : {}), ...(replies !== undefined ? { comments: replies } : {}) } } : {}),
    });
  }
  if (payload.posts.length > 0 && items.length === 0) throw new SourceAdapterError("Bluesky returned no posts matching its documented schema.", "schema");
  return items;
}

export function createBlueskyAdapter(options: BlueskyAdapterOptions = {}): SourceAdapter {
  const { handle: rawHandle, appPassword: rawPassword, ...sourceOptions } = options;
  const identifier = rawHandle?.trim();
  const password = rawPassword?.trim();
  // The access token lives only in this closure for the life of the process.
  let session: Promise<string> | undefined;

  const createSession = async (requestOptions: SearchOptions): Promise<string> => {
    let payload: unknown;
    try {
      payload = await fetchSourceJson(BLUESKY_CREATE_SESSION_ENDPOINT, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      }, { ...sourceOptions, signal: requestOptions.signal });
    } catch (error) {
      if (!(error instanceof SourceAdapterError)) throw error;
      // Report only the status class; the request body carried the password.
      const status = error.httpStatus;
      const code = status === 400 || status === 401 ? "auth_required" : error.code;
      throw new SourceAdapterError(`Bluesky authentication failed${status ? ` (HTTP ${status})` : ""}.`, code, { httpStatus: status });
    }
    const accessJwt = text(record(payload)?.accessJwt);
    if (!accessJwt) throw new SourceAdapterError("Bluesky createSession returned an unknown response schema.", "schema");
    return accessJwt;
  };

  const token = (requestOptions: SearchOptions): Promise<string> => {
    if (!session) {
      const pending = createSession(requestOptions);
      session = pending;
      pending.catch(() => { if (session === pending) session = undefined; });
    }
    return session;
  };

  return {
    id: "bluesky",
    label: "Bluesky (authenticated post search)",
    capabilities: ["search"],
    async search(query, searchOptions = {}) {
      if (!identifier || !password) throw new SourceAdapterError("Bluesky is unconfigured; an explicit handle and app password are required.", "auth_required");
      const url = new URL(BLUESKY_SEARCH_POSTS_ENDPOINT);
      url.searchParams.set("q", query);
      url.searchParams.set("sort", "latest");
      url.searchParams.set("limit", String(Math.min(limit(searchOptions), BLUESKY_MAX_RESULTS)));
      const since = dateOption(searchOptions.after);
      const until = dateOption(searchOptions.before);
      if (since) url.searchParams.set("since", since.toISOString());
      if (until) url.searchParams.set("until", until.toISOString());
      const request = (accessJwt: string) => fetchSourceJson(url.toString(), { headers: { accept: "application/json", authorization: `Bearer ${accessJwt}` } }, { ...sourceOptions, ...searchOptions });
      const reused = session !== undefined;
      const current = token(searchOptions);
      const accessJwt = await current;
      try {
        return normalizeBluesky(await request(accessJwt));
      } catch (error) {
        // An expired access token is reported as 401, or as 400 ExpiredToken by
        // the PDS. Re-create the session once, and only for a reused token.
        const status = error instanceof SourceAdapterError ? error.httpStatus : undefined;
        if (!(status === 401 || (reused && status === 400))) throw error;
        if (session === current) session = undefined;
        return normalizeBluesky(await request(await token(searchOptions)));
      }
    },
  };
}

export function createPublicSocialSourceAdapters(options: SourceAdapterOptions = {}): readonly SourceAdapter[] {
  return [createRedditAdapter(options), createPolymarketAdapter(options)];
}

export function createSocialSourceAdapters(options: SocialSourceAdapterOptions = {}): readonly SourceAdapter[] {
  const adapters: SourceAdapter[] = [...createPublicSocialSourceAdapters(options)];
  if (options.xBearerToken?.trim()) adapters.push(createXAdapter({ ...options, bearerToken: options.xBearerToken }));
  if (options.youtubeApiKey?.trim()) adapters.push(createYouTubeAdapter({ ...options, apiKey: options.youtubeApiKey }));
  if (options.blueskyHandle?.trim() && options.blueskyAppPassword?.trim()) {
    const { blueskyHandle, blueskyAppPassword, xBearerToken: _x, youtubeApiKey: _y, ...sourceOptions } = options;
    adapters.push(createBlueskyAdapter({ ...sourceOptions, handle: blueskyHandle, appPassword: blueskyAppPassword }));
  }
  return adapters;
}

export const createRedditSourceAdapter = createRedditAdapter;
export const createPolymarketSourceAdapter = createPolymarketAdapter;
export const createXSourceAdapter = createXAdapter;
export const createYouTubeSourceAdapter = createYouTubeAdapter;
export const createBlueskySourceAdapter = createBlueskyAdapter;
