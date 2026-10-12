import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

test("package exposes one extension and skill with a pinned retrieval dependency", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(manifest.name, "pi-research-kit");
  assert.notEqual(manifest.private, true);
  assert.deepEqual(manifest.pi, {extensions: ["src/index.ts"], skills: ["skills/research-kit"]});
  assert.equal(manifest.dependencies["ketch-cli"], "0.17.1");
  assert.deepEqual(Object.keys(manifest.dependencies), ["ketch-cli"]);
  for (const [name, version] of Object.entries(manifest.peerDependencies)) {
    assert.equal(version, "*");
    assert.ok(manifest.devDependencies[name]);
  }
  for (const path of Object.values(manifest.exports)) await access(new URL(path as string, root));
  await access(new URL("skills/research-kit/SKILL.md", root));
});

test("skill references the shipped README and public docs are self-contained", async () => {
  const skill = await readFile(new URL("skills/research-kit/SKILL.md", root), "utf8");
  assert.match(skill, /\]\(\.\.\/\.\.\/README\.md\)/);
  for (const path of ["README.md", "AGENTS.md", "CONTRIBUTING.md", "NOTICE.md", "RELEASING.md"]) {
    const content = await readFile(new URL(path, root), "utf8");
    assert.doesNotMatch(content, /\/home\/[^/\s]+\/|\/Users\/[^/\s]+\//);
  }
});
