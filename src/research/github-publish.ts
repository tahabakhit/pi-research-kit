import { createHash } from "node:crypto";
import type { LibraryRecord, PublicationContract } from "./types.ts";
import { renderAtom, renderLibraryHtml } from "./exports.ts";

const API_ORIGIN = "https://api.github.com";
const PUBLIC_ORIGIN = "https://github.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_MAX_ARTIFACT_BYTES = 512_000;
const SHA_PATTERN = /^[a-f0-9]{7,64}$/i;

export interface GitHubPublicationConfig {
  /** Dedicated repository owner. This is never read from an environment variable. */
  owner: string;
  /** Dedicated repository name. This is never read from an environment variable. */
  repo: string;
  /** Explicit branch to update. */
  branch: string;
  /** Explicit token supplied by the caller; GH_TOKEN is never consulted. */
  token: string;
  /** Explicit, repository-relative prefix owned by this publisher. */
  pathPrefix: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxArtifactBytes?: number;
}

export interface GitHubPublicationFilePreview {
  path: string;
  bytes: number;
  sha256: string;
}

export interface GitHubPublicationPreview {
  provider: "github-pages";
  repository: string;
  branch: string;
  prefix: string;
  recordId: string;
  /** Repository/branch/path destination; this is not a claimed live Pages URL. */
  destination: string;
  files: readonly GitHubPublicationFilePreview[];
  contentHash: string;
}

interface GitHubResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}

export type GitHubFetch = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: "error";
}) => Promise<GitHubResponse>;

export interface GitHubPublicationDependencies {
  fetch?: GitHubFetch;
}

interface ValidatedConfig extends GitHubPublicationConfig {
  timeoutMs: number;
  maxResponseBytes: number;
  maxArtifactBytes: number;
  prefixParts: readonly string[];
}

interface PublicationFile {
  path: string;
  content: string;
  sha256: string;
  bytes: number;
}

class GitHubPublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubPublicationError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validateSegment(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value === "." || value === ".." || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new GitHubPublicationError(`GitHub publication requires a valid ${label}.`);
  }
  return value;
}

function validateBranch(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") || /[\u0000-\u0020~^:?*]/.test(value) || value.includes("[") || value.includes("]") || value.startsWith("/") || value.endsWith("/") || value.includes("//") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new GitHubPublicationError("GitHub publication requires a valid branch.");
  }
  return value;
}

function validatePrefix(value: unknown): { value: string; parts: readonly string[] } {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") || value.startsWith("/") || value.endsWith("/")) {
    throw new GitHubPublicationError("GitHub publication requires an explicit relative path prefix.");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new GitHubPublicationError("GitHub publication path prefix is unsafe.");
  }
  return { value: parts.join("/"), parts };
}

function validateRecordId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(id)) throw new GitHubPublicationError("Research record id is unsafe for publication.");
  return id;
}

function validateConfig(config: GitHubPublicationConfig): ValidatedConfig {
  if (!config || typeof config !== "object") throw new GitHubPublicationError("GitHub publication configuration is missing.");
  const owner = validateSegment(config.owner, "repository owner");
  const repo = validateSegment(config.repo, "repository name");
  const branch = validateBranch(config.branch);
  if (typeof config.token !== "string" || !config.token.trim()) {
    throw new GitHubPublicationError("GitHub publication requires an explicitly supplied token.");
  }
  const prefix = validatePrefix(config.pathPrefix);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxArtifactBytes = config.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new GitHubPublicationError("GitHub publication timeout is out of bounds.");
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1_024 || maxResponseBytes > 10_000_000) throw new GitHubPublicationError("GitHub response bound is out of bounds.");
  if (!Number.isInteger(maxArtifactBytes) || maxArtifactBytes < 1_024 || maxArtifactBytes > 5_000_000) throw new GitHubPublicationError("GitHub artifact bound is out of bounds.");
  return { ...config, owner, repo, branch, pathPrefix: prefix.value, timeoutMs, maxResponseBytes, maxArtifactBytes, prefixParts: prefix.parts };
}

function repositoryUrl(config: ValidatedConfig): string {
  return `${PUBLIC_ORIGIN}/${config.owner}/${config.repo}`;
}

function destinationFor(config: ValidatedConfig, recordId: string): string {
  return `${repositoryUrl(config)}/tree/${encodeURIComponent(config.branch)}/${config.pathPrefix}/${recordId}`;
}

function safeMarkdown(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]()#+.!|])/g, "\\$1");
}

function safeMarkdownUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "#";
    return `<${url.toString().replace(/[<>\s]/g, (character) => encodeURIComponent(character))}>`;
  } catch {
    return "#";
  }
}

function renderMarkdown(record: LibraryRecord): string {
  const evidence = record.evidence.map((item) => `- [${safeMarkdown(item.title)}](${safeMarkdownUrl(item.url)}) — ${safeMarkdown(item.publishedAt ?? "date unknown")} (${safeMarkdown(item.source)})`).join("\n");
  return [
    `# ${safeMarkdown(record.title)}`,
    "",
    safeMarkdown(record.summary),
    "",
    `- Created: ${safeMarkdown(record.createdAt)}`,
    `- Updated: ${safeMarkdown(record.updatedAt)}`,
    ...(record.query ? [`- Query: ${safeMarkdown(record.query)}`] : []),
    "",
    safeMarkdown(record.content),
    "",
    "## Sources",
    evidence || "No sources.",
    "",
    "## Coverage",
    record.coverage.map((item) => `- ${safeMarkdown(item)}`).join("\n") || "- Not reported",
    "",
  ].join("\n");
}

function generatedFiles(config: ValidatedConfig, record: LibraryRecord): PublicationFile[] {
  const id = validateRecordId(record.id);
  const directory = [...config.prefixParts, id].join("/");
  const contents = [
    ["index.html", renderLibraryHtml([record], record.title)],
    ["atom.xml", renderAtom([record], `${record.title} research`, `urn:pi-research-kit:${record.id}`)],
    ["record.md", renderMarkdown(record)],
  ] as const;
  const files = contents.map(([name, content]) => ({ path: `${directory}/${name}`, content, sha256: sha256(content), bytes: byteLength(content) }));
  if (files.some((file) => file.bytes > config.maxArtifactBytes)) throw new GitHubPublicationError("Generated publication artifact exceeds the configured bound.");
  return files;
}

function previewFromFiles(config: ValidatedConfig, record: LibraryRecord, files: readonly PublicationFile[]): GitHubPublicationPreview {
  const publicFiles = files.map(({ path, bytes, sha256: digest }) => ({ path, bytes, sha256: digest }));
  const contentHash = sha256(publicFiles.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}`).join("\n"));
  return {
    provider: "github-pages",
    repository: repositoryUrl(config),
    branch: config.branch,
    prefix: config.pathPrefix,
    recordId: record.id,
    destination: destinationFor(config, record.id),
    files: publicFiles,
    contentHash,
  };
}

/** Build the exact local-only destination and content digest shown for confirmation. */
export function previewGitHubPublication(record: LibraryRecord, config: GitHubPublicationConfig): GitHubPublicationPreview {
  const validated = validateConfig(config);
  return previewFromFiles(validated, record, generatedFiles(validated, record));
}

function apiPath(path: string): string {
  // Every endpoint is assembled below the fixed HTTPS GitHub API origin.
  return `${API_ORIGIN}${path}`;
}

function redact(value: string, token: string): string {
  return value
    .replaceAll(token, "[REDACTED]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/("(?:token|authorization|password|secret)"\s*:\s*")([^"\\]*)/gi, "$1[REDACTED]")
    .slice(0, 512);
}

async function readBounded(response: GitHubResponse, maxBytes: number): Promise<string> {
  const contentLength = response.headers?.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) throw new GitHubPublicationError("GitHub response exceeded the configured bound.");
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) { await reader.cancel(); throw new GitHubPublicationError("GitHub response exceeded the configured bound."); }
        chunks.push(part.value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally { reader.releaseLock(); }
  }
  const body = await response.text(); // Fixture transports may supply only text().
  if (byteLength(body) > maxBytes) throw new GitHubPublicationError("GitHub response exceeded the configured bound.");
  return body;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GitHubPublicationError(`GitHub returned an invalid ${label}.`);
  return value as Record<string, unknown>;
}

function shaField(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) throw new GitHubPublicationError(`GitHub returned an invalid ${label}.`);
  return value;
}

class GitHubApi {
  private readonly config: ValidatedConfig;
  private readonly fetchImpl: GitHubFetch;
  constructor(config: ValidatedConfig, fetchImpl: GitHubFetch) { this.config = config; this.fetchImpl = fetchImpl; }

  async json(path: string, init: { method?: string; body?: string; signal?: AbortSignal } = {}): Promise<unknown> {
    const externalSignal = init.signal;
    if (externalSignal?.aborted) throw new GitHubPublicationError("GitHub publication was cancelled.");
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) abort();
    try {
      const request = (async () => {
        const response = await this.fetchImpl(apiPath(path), {
          method: init.method ?? "GET",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${this.config.token}`,
            "content-type": "application/json",
            "user-agent": "research-pi-research-kit",
            "x-github-api-version": "2022-11-28",
          },
          ...(init.body ? { body: init.body } : {}),
          signal: controller.signal,
          redirect: "error",
        });
        return { response, body: await readBounded(response, this.config.maxResponseBytes) };
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new GitHubPublicationError("GitHub request timed out."));
        }, this.config.timeoutMs);
      });
      const { response, body } = await Promise.race([request, timeout]);
      if (!response.ok) {
        throw new GitHubPublicationError(`GitHub API request failed (${response.status}); response body withheld.`);
      }
      if (!body) return {};
      try { return JSON.parse(body) as unknown; }
      catch { throw new GitHubPublicationError("GitHub returned malformed JSON."); }
    } catch (error) {
      if (error instanceof GitHubPublicationError) throw error;
      if (timedOut) throw new GitHubPublicationError("GitHub request timed out.");
      if (externalSignal?.aborted) throw new GitHubPublicationError("GitHub publication was cancelled.");
      const message = error instanceof Error ? error.message : "network error";
      throw new GitHubPublicationError(`GitHub request failed: ${redact(message, this.config.token)}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abort);
    }
  }
}

function pathPart(value: string): string {
  return encodeURIComponent(value);
}

async function publishWithConfig(config: ValidatedConfig, record: LibraryRecord, signal: AbortSignal | undefined, fetchImpl: GitHubFetch): Promise<{ status: "published"; reference: string; message: string }> {
  const files = generatedFiles(config, record);
  const preview = previewFromFiles(config, record, files);
  const api = new GitHubApi(config, fetchImpl);
  const refPath = `/repos/${pathPart(config.owner)}/${pathPart(config.repo)}/git/ref/heads/${pathPart(config.branch)}`;
  const ref = objectRecord(await api.json(refPath, { signal }), "branch reference");
  const refObject = objectRecord(ref.object, "branch reference object");
  const baseCommit = shaField(refObject.sha, "branch reference sha");
  const commit = objectRecord(await api.json(`/repos/${pathPart(config.owner)}/${pathPart(config.repo)}/git/commits/${baseCommit}`, { signal }), "commit");
  const tree = objectRecord(commit.tree, "commit tree");
  const baseTree = shaField(tree.sha, "commit tree sha");
  const treeResult = objectRecord(await api.json(`/repos/${pathPart(config.owner)}/${pathPart(config.repo)}/git/trees/${baseTree}?recursive=1`, { signal }), "tree");
  if (treeResult.truncated === true) throw new GitHubPublicationError("GitHub tree was truncated; refusing to publish without collision certainty.");
  const treeEntries = treeResult.tree;
  if (!Array.isArray(treeEntries) || treeEntries.length > 100_000) throw new GitHubPublicationError("GitHub returned an invalid or oversized tree.");
  const existingEntries = treeEntries.map((entry) => {
    const item = objectRecord(entry, "tree entry");
    if (typeof item.path !== "string" || (item.type !== "blob" && item.type !== "tree")) throw new GitHubPublicationError("GitHub returned an invalid tree entry.");
    return { path: item.path, type: item.type };
  });
  const recordDirectory = `${config.pathPrefix}/${record.id}`;
  if (existingEntries.some((existing) => existing.path === recordDirectory || existing.path.startsWith(`${recordDirectory}/`) || (existing.type === "blob" && preview.files.some((file) => file.path === existing.path || file.path.startsWith(`${existing.path}/`))))) {
    throw new GitHubPublicationError("Publication destination already exists; refusing to overwrite it.");
  }

  const blobShas: string[] = [];
  for (const file of files) {
    const blob = objectRecord(await api.json(`/repos/${pathPart(config.owner)}/${pathPart(config.repo)}/git/blobs`, { method: "POST", body: JSON.stringify({ content: file.content, encoding: "utf-8" }), signal }), "blob");
    blobShas.push(shaField(blob.sha, "blob sha"));
  }
  const newTree = objectRecord(await api.json(`/repos/${pathPart(config.owner)}/${pathPart(config.repo)}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTree, tree: files.map((file, index) => ({ path: file.path, mode: "100644", type: "blob", sha: blobShas[index] })) }),
    signal,
  }), "new tree");
  const newTreeSha = shaField(newTree.sha, "new tree sha");
  const newCommit = objectRecord(await api.json(`/repos/${pathPart(config.owner)}/${pathPart(config.repo)}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: `Publish research record ${record.id}`, tree: newTreeSha, parents: [baseCommit] }),
    signal,
  }), "new commit");
  const newCommitSha = shaField(newCommit.sha, "new commit sha");

  const currentRef = objectRecord(await api.json(refPath, { signal }), "current branch reference");
  const currentRefObject = objectRecord(currentRef.object, "current branch reference object");
  if (shaField(currentRefObject.sha, "current branch reference sha") !== baseCommit) {
    throw new GitHubPublicationError("Publication conflict: branch advanced after the expected base was read; no ref update was attempted.");
  }
  await api.json(`/repos/${pathPart(config.owner)}/${pathPart(config.repo)}/git/refs/heads/${pathPart(config.branch)}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: newCommitSha, force: false }),
    signal,
  });
  return {
    status: "published",
    reference: `${repositoryUrl(config)}/commit/${newCommitSha}`,
    message: `Published ${preview.files.length} research artifacts in ${config.owner}/${config.repo}@${config.branch}. Commit URL returned; GitHub Pages deployment was not verified, so no live site URL is claimed.`,
  };
}

/** Create a publication contract for one explicitly configured GitHub repository. */
export function createGitHubPublication(config: GitHubPublicationConfig, dependencies: GitHubPublicationDependencies = {}): PublicationContract & { preview(record: LibraryRecord): GitHubPublicationPreview } {
  const validated = validateConfig(config);
  const fetchImpl = dependencies.fetch ?? (globalThis.fetch as unknown as GitHubFetch);
  if (typeof fetchImpl !== "function") throw new GitHubPublicationError("No fetch implementation is available for GitHub publication.");
  return {
    id: "github-pages",
    label: `GitHub Pages (${validated.owner}/${validated.repo})`,
    preview(record) {
      return previewGitHubPublication(record, validated);
    },
    async publish(record, options) {
      try {
        return await publishWithConfig(validated, record, options?.signal, fetchImpl);
      } catch (error) {
        if (error instanceof GitHubPublicationError) return { status: "failed", message: error.message };
        throw error;
      }
    },
  };
}

export { API_ORIGIN as GITHUB_API_ORIGIN };
