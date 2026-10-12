import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const npm = process.env.npm_execpath;
assert.ok(npm, 'Run through npm run pack:smoke');
const root = await mkdtemp(join(await realpath(tmpdir()), 'research-kit-pack-'));
const pkgRoot = process.cwd();
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.PI_OFFLINE = '1';
function npmRun(args, cwd) {
  const result = spawnSync(process.execPath, [npm, ...args], {
    cwd, encoding: 'utf8', timeout: args[0] === 'install' ? 600000 : 60000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `npm ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}
try {
  const packed = JSON.parse(npmRun(['pack', '--ignore-scripts', '--json', '--pack-destination', root], pkgRoot));
  const names = packed[0].files.map(file => file.path);
  assert.ok(names.includes('src/index.ts'));
  assert.ok(names.includes('skills/research-kit/SKILL.md'));
  assert.ok(!names.some(name => /^(tests|node_modules|\.github)\//.test(name)));
  const install = join(root, 'install');
  await mkdir(install);
  await writeFile(join(install, 'package.json'), JSON.stringify({name: 'research-kit-smoke', private: true, type: 'module'}));
  // Install host peers explicitly: Pi normally supplies them, not this package.
  const manifest = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'));
  const hosts = Object.keys(manifest.peerDependencies).map(name => `${name}@${manifest.devDependencies[name]}`);
  npmRun(['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', join(root, packed[0].filename), ...hosts], install);
  const require = createRequire(join(install, 'package.json'));
  const packagePath = join(install, 'node_modules', manifest.name);
  for (const [specifier, relativePath] of [
    ['pi-research-kit', 'index.ts'],
    ['pi-research-kit/ketch/client', 'ketch/client.ts'],
    ['pi-research-kit/tools', 'tools/index.ts'],
    ['pi-research-kit/core', 'research/index.ts'],
  ]) assert.equal(require.resolve(specifier), join(packagePath, 'src', relativePath));

  const {DefaultResourceLoader} = await import(pathToFileURL(join(install, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js')).href);
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'cwd');
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({packages: [packagePath]}));
  const loader = new DefaultResourceLoader({agentDir, cwd, noContextFiles: true, noPromptTemplates: true, noThemes: true});
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const tools = loaded.extensions.flatMap(extension => [...extension.tools.keys()]);
  assert.equal(tools.length, 17);
  assert.equal(new Set(tools).size, 17);
  assert.deepEqual(loader.getSkills().skills.map(skill => skill.name), ['research-kit']);
  const native = require.resolve(`@ketch-cli/${process.platform}-${process.arch}/bin/${process.platform === 'win32' ? 'ketch.exe' : 'ketch'}`);
  const version = spawnSync(native, ['--version'], {encoding: 'utf8', timeout: 10000});
  assert.equal(version.status, 0);
  assert.match(version.stdout, /0\.17\.1/);
  console.log('Production tarball: standalone extension, 17 unique tools, skill, exports, and pinned native Ketch verified.');
} finally {
  await rm(root, {recursive: true, force: true});
}
