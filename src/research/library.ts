import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readdir, readFile, rename, writeFile, link, unlink, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LibraryRecord } from "./types.ts";

export function defaultResearchRoot(): string {
  return process.env.PI_RESEARCH_HOME?.trim() || join(homedir(), ".local", "share", "pi-research-kit");
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(id);
}

/** Check every existing ancestor without resolving through an untrusted symlink. */
export async function assertSafeAncestors(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = absolute;
  while (true) {
    try {
      const info = await lstat(current);
      // A system temp directory can be a symlink on macOS. It is tolerated only
      // at the exact temp root; user-controlled links are never followed.
      if (info.isSymbolicLink() && resolve(current) !== resolve(tmpdir())) {
        throw new Error(`Refusing symlink path: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = resolve(current, "..");
    if (parent === current) return;
    current = parent;
  }
}

export async function ensureSafeDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  await assertSafeAncestors(absolute);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refusing unsafe directory: ${absolute}`);
}

export async function assertSafeFile(path: string, options: { allowMissing?: boolean } = {}): Promise<void> {
  const absolute = resolve(path);
  await assertSafeAncestors(dirname(absolute));
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink path: ${absolute}`);
    if (!info.isFile() || info.nlink > 1) throw new Error(`Refusing unsafe state file: ${absolute}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissing) return;
    throw error;
  }
}

async function assertAbsent(path: string): Promise<void> {
  await assertSafeAncestors(dirname(path));
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || info.nlink > 1) throw new Error(`Refusing unsafe existing path: ${path}`);
    throw new Error(`Refusing to overwrite existing path: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Create a file atomically without replacing an existing file or symlink. */
export async function atomicCreate(path: string, content: string): Promise<void> {
  const absolute = resolve(path);
  await assertAbsent(absolute);
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    // link() is an atomic no-replace operation on the same filesystem. Unlike
    // rename(), it cannot silently replace a destination that appeared late.
    await link(temporary, absolute);
  } finally {
    try { await unlink(temporary); } catch { /* best effort cleanup */ }
  }
}

/** Replace one state file while holding the caller's lock. */
export async function atomicReplace(path: string, content: string): Promise<void> {
  const absolute = resolve(path);
  await assertSafeAncestors(dirname(absolute));
  await assertSafeFile(absolute, { allowMissing: true });
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, absolute);
  } finally {
    try { await unlink(temporary); } catch { /* best effort cleanup */ }
  }
}

/** Refuse concurrent revisions rather than guessing how to merge them. */
export async function withDirectoryLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${resolve(target)}.lock`;
  await assertSafeAncestors(dirname(lockPath));
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Refusing concurrent edit; lock already exists: ${lockPath}`);
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export function recordMarkdown(record: LibraryRecord): string {
  const evidence = record.evidence.map((item) => `- [${item.title}](${item.url}) — ${item.publishedAt ?? "date unknown"} (${item.source})`).join("\n");
  return [
    `# ${record.title}`,
    "",
    record.summary,
    "",
    `- Created: ${record.createdAt}`,
    `- Updated: ${record.updatedAt}`,
    ...(record.query ? [`- Query: ${record.query}`] : []),
    "",
    record.content,
    "",
    "## Sources",
    evidence || "No sources.",
    "",
    "## Coverage",
    record.coverage.map((item) => `- ${item}`).join("\n") || "- Not reported",
    "",
  ].join("\n");
}

export const LIBRARY_LIMITS = { recordBytes: 8 * 1024 * 1024, scanBytes: 64 * 1024 * 1024, records: 1000 } as const;

function validateRecord(value: unknown, expectedId?: string): asserts value is LibraryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid library record schema.");
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !validId(record.id) || (expectedId !== undefined && record.id !== expectedId)) throw new Error("Invalid library record identity.");
  for (const key of ["title", "summary", "content", "createdAt", "updatedAt"]) if (typeof record[key] !== "string") throw new Error("Invalid library record schema.");
  if (!Number.isFinite(Date.parse(record.createdAt as string)) || !Number.isFinite(Date.parse(record.updatedAt as string))) throw new Error("Invalid library record dates.");
  if (!Array.isArray(record.evidence) || !Array.isArray(record.coverage) || record.coverage.some(item => typeof item !== "string")) throw new Error("Invalid library evidence schema.");
  for (const value of record.evidence) {
    if (!value || typeof value !== "object" || typeof value.title !== "string" || typeof value.url !== "string" || typeof value.source !== "string") throw new Error("Invalid library evidence schema.");
    const url = new URL(value.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Unsafe library evidence URL.");
  }
}

export class LocalResearchLibrary {
  readonly root: string;
  private readonly recordsDir: string;

  constructor(root = defaultResearchRoot()) {
    this.root = resolve(root);
    this.recordsDir = join(this.root, "library");
  }

  async init(): Promise<void> {
    await ensureSafeDirectory(this.root);
    await ensureSafeDirectory(this.recordsDir);
  }

  private pathFor(id: string, extension: "json" | "md"): string {
    if (!validId(id)) throw new Error("Invalid library record id.");
    const path = join(this.recordsDir, `${id}.${extension}`);
    if (!resolve(path).startsWith(`${this.recordsDir}${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("Invalid library path.");
    return path;
  }

  async save(record: LibraryRecord): Promise<void> {
    validateRecord(record);
    const encoded = JSON.stringify(record, null, 2) + "\n";
    if (Buffer.byteLength(encoded) > LIBRARY_LIMITS.recordBytes) throw new Error("Library record exceeds the size limit; reduce the evidence before saving.");
    await this.init();
    const jsonPath = this.pathFor(record.id, "json");
    const markdownPath = this.pathFor(record.id, "md");
    await withDirectoryLock(jsonPath, async () => {
      // Check both destinations before creating either artifact. Existing
      // records are immutable; callers must choose a new UUID for a revision.
      await assertAbsent(jsonPath);
      await assertAbsent(markdownPath);
      // JSON is the discoverable commit marker. An interrupted pre-commit save
      // may leave an ignored Markdown orphan; never delete it automatically.
      await atomicCreate(markdownPath, recordMarkdown(record));
      await atomicCreate(jsonPath, encoded);
    });
  }

  async get(id: string): Promise<LibraryRecord | null> {
    await assertSafeAncestors(this.recordsDir);
    const path = this.pathFor(id, "json");
    try {
      await assertSafeFile(path);
      if ((await lstat(path)).size > LIBRARY_LIMITS.recordBytes) throw new Error("Library record exceeds the read limit.");
      const body = await readFile(path, "utf8");
      if (Buffer.byteLength(body) > LIBRARY_LIMITS.recordBytes) throw new Error("Library record exceeds the read limit.");
      const record: unknown = JSON.parse(body);
      validateRecord(record, id);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(): Promise<LibraryRecord[]> {
    await assertSafeAncestors(this.recordsDir);
    let names: string[];
    try { names = await readdir(this.recordsDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const selected = names.filter(item => item.endsWith(".json")).sort();
    if (selected.length > LIBRARY_LIMITS.records) throw new Error("Library scan exceeds the record limit; archive older records before retrying.");
    let bytes = 0;
    const records: LibraryRecord[] = [];
    for (const name of selected) {
      await assertSafeFile(join(this.recordsDir, name));
      bytes += (await lstat(join(this.recordsDir, name))).size;
      if (bytes > LIBRARY_LIMITS.scanBytes) throw new Error("Library scan exceeds the byte budget; archive older records before retrying.");
      const id = name.slice(0, -5);
      const record = await this.get(id);
      if (record) records.push(record);
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  async search(query: string): Promise<LibraryRecord[]> {
    const terms = query.toLocaleLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!terms.length) return this.list();
    const records = await this.list();
    return records.filter((record) => {
      const haystack = `${record.title} ${record.summary} ${record.content} ${record.query ?? ""}`.toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  async exists(): Promise<boolean> {
    try { await access(this.root); return true; } catch { return false; }
  }
}
