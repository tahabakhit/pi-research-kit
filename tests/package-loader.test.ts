import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat, mkdir } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const KETCH_TOOLS = [
  "ketch_search",
  "ketch_scrape",
  "ketch_crawl",
  "ketch_code",
  "ketch_docs",
  "web_search",
  "web_fetch",
] as const;

const RESEARCH_TOOLS = [
  "research_recent",
  "research_synthesize",
  "research_library",
  "research_watchlist",
  "research_doctor",
  "research_publish",
  "research_handoff",
] as const;

const WORKFLOW_TOOLS = ["research_compare", "research_discover", "research_export"] as const;
const EXPECTED_TOOLS = [...KETCH_TOOLS, ...RESEARCH_TOOLS, ...WORKFLOW_TOOLS];

const extensionRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const extensionIndex = join(extensionRoot, "index.ts");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("Pi loads the package/index entry once with all 17 tools and no startup side effects", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pi-research-loader-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const stateDir = join(root, "research-state");
  await mkdir(cwd);
  await mkdir(agentDir);

  const originalFetch = globalThis.fetch;
  const originalHome = process.env.HOME;
  const originalOffline = process.env.PI_OFFLINE;
  const originalResearchHome = process.env.PI_RESEARCH_HOME;
  let fetchCalls = 0;

  process.env.HOME = join(root, "home");
  process.env.PI_OFFLINE = "1";
  process.env.PI_RESEARCH_HOME = stateDir;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network is forbidden during loader initialization");
  };

  try {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      // Exercise both package-manifest discovery and its resolved index entry.
      additionalExtensionPaths: [extensionRoot, extensionIndex],
    });

    await loader.reload();
    const first = loader.getExtensions();
    assert.deepEqual(first.errors, []);
    assert.equal(first.extensions.length, 1);
    assert.equal(first.extensions[0]?.resolvedPath, extensionIndex);
    assert.deepEqual(
      [...(first.extensions[0]?.tools.keys() ?? [])].sort(),
      [...EXPECTED_TOOLS].sort(),
    );
    assert.equal(first.extensions[0]?.tools.size, 17);

    await loader.reload();
    const second = loader.getExtensions();
    assert.deepEqual(second.errors, []);
    assert.equal(second.extensions.length, 1);
    assert.equal(second.extensions[0]?.tools.size, 17);
    assert.deepEqual(
      [...(second.extensions[0]?.tools.keys() ?? [])].sort(),
      [...EXPECTED_TOOLS].sort(),
    );

    assert.equal(fetchCalls, 0);
    assert.equal(await exists(stateDir), false);
    assert.equal(await exists(join(agentDir, "state")), false);
    assert.equal(await exists(join(cwd, ".pi")), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = originalOffline;
    if (originalResearchHome === undefined) delete process.env.PI_RESEARCH_HOME;
    else process.env.PI_RESEARCH_HOME = originalResearchHome;
    await rm(root, { recursive: true, force: true });
  }
});
