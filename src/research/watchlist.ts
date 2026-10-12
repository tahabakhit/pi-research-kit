import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { KetchResearchDeps, LibraryRecord, ResearchOptions, ResearchResult, WatchItem } from "./types.ts";
import { LocalResearchLibrary, atomicCreate, atomicReplace, assertSafeAncestors, assertSafeFile, ensureSafeDirectory, withDirectoryLock } from "./library.ts";
import { runRecentResearch } from "./research.ts";

export class ResearchWatchlist {
  readonly path: string;
  private readonly library: LocalResearchLibrary;
  private readonly root: string;

  constructor(root: string, library = new LocalResearchLibrary(root)) {
    this.root = resolve(root);
    this.path = join(this.root, "watchlist.json");
    this.library = library;
  }

  private async read(): Promise<WatchItem[]> {
    await assertSafeAncestors(this.root);
    try {
      await assertSafeFile(this.path);
      return JSON.parse(await readFile(this.path, "utf8")) as WatchItem[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeUnlocked(items: WatchItem[]): Promise<void> {
    await ensureSafeDirectory(this.root);
    await atomicReplace(this.path, JSON.stringify(items, null, 2) + "\n");
  }

  private async edit<T>(operation: (items: WatchItem[]) => Promise<{ items: WatchItem[]; result: T }>): Promise<T> {
    await ensureSafeDirectory(this.root);
    return withDirectoryLock(this.path, async () => {
      const current = await this.read();
      const changed = await operation(current);
      const history = join(this.root, "watchlist-history");
      await ensureSafeDirectory(history);
      await atomicCreate(join(history, `${randomUUID()}.json`), JSON.stringify(current, null, 2) + "\n");
      await this.writeUnlocked(changed.items);
      return changed.result;
    });
  }

  async list(): Promise<WatchItem[]> {
    return (await this.read()).sort((a, b) => a.query.localeCompare(b.query));
  }

  async add(query: string, options: { days?: number; limit?: number } = {}): Promise<WatchItem> {
    const clean = query.trim();
    if (!clean) throw new Error("Watch query must not be empty.");
    const now = new Date().toISOString();
    const item: WatchItem = {
      id: randomUUID(),
      query: clean,
      days: options.days ?? 30,
      limit: options.limit ?? 10,
      createdAt: now,
      updatedAt: now,
    };
    return this.edit(async (items) => ({ items: [...items, item], result: item }));
  }

  async update(id: string, changes: { query?: string; days?: number; limit?: number }, expected?: WatchItem): Promise<WatchItem> {
    return this.edit(async (items) => {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`Watch item not found: ${id}`);
      const current = items[index]!;
      if (expected && JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("Watch item changed since confirmation; retry.");
      const query = changes.query?.trim() || current.query;
      if (!query) throw new Error("Watch query must not be empty.");
      const updated: WatchItem = {
        ...current,
        query,
        days: changes.days ?? current.days,
        limit: changes.limit ?? current.limit,
        updatedAt: new Date().toISOString(),
      };
      const next = [...items];
      next[index] = updated;
      return { items: next, result: updated };
    });
  }

  async remove(id: string, expected?: WatchItem): Promise<boolean> {
    return this.edit(async (items) => {
      if (expected && JSON.stringify(items.find(item => item.id === id)) !== JSON.stringify(expected)) throw new Error("Watch item changed since confirmation; retry.");
      const next = items.filter((item) => item.id !== id);
      return { items: next, result: next.length !== items.length };
    });
  }

  async refresh(id: string, deps: KetchResearchDeps, options: ResearchOptions & { expected?: WatchItem } = {}): Promise<ResearchResult> {
    const item = (await this.read()).find((candidate) => candidate.id === id);
    if (!item) throw new Error(`Watch item not found: ${id}`);
    if (options.expected && JSON.stringify(item) !== JSON.stringify(options.expected)) throw new Error("Watch item changed since confirmation; no research was started.");
    const result = await runRecentResearch(deps, item.query, { ...options, days: options.days ?? item.days, limit: options.limit ?? item.limit });
    const now = new Date().toISOString();
    const evidence = [...result.recent, ...result.unknownDate];
    const record: LibraryRecord = {
      id: randomUUID(),
      title: `Watch: ${item.query}`,
      summary: `Explicit refresh for ${item.query}; ${result.recent.length} recent and ${result.unknownDate.length} unknown-date sources.`,
      content: result.recent.map((source) => `- ${source.title}: ${source.snippet}`).join("\n"),
      query: item.query,
      createdAt: now,
      updatedAt: now,
      evidence,
      coverage: result.unavailableCoverage,
    };
    await this.library.save(record);
    await this.edit(async (items) => {
      if (JSON.stringify(items.find(candidate => candidate.id === id)) !== JSON.stringify(item)) throw new Error(`Research saved as ${record.id}, but the watch item changed; refresh metadata was not overwritten.`);
      return {items: items.map(candidate => candidate.id === id ? {...candidate,updatedAt:now,lastRefreshAt:now} : candidate),result};
    });
    return result;
  }
}
