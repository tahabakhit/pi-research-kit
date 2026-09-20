import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const npm = process.env.npm_execpath;
assert.ok(npm, 'Run through npm run pack:smoke');
const root = await mkdtemp(join(tmpdir(), 'research-kit-pack-'));
const pkgRoot = process.cwd();
function npmRun(args, cwd) {
  const result = spawnSync(process.execPath, [npm, ...args], {cwd, encoding:'utf8',timeout:180000});
  assert.equal(result.status, 0, `npm ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}
try {
  const packed = JSON.parse(npmRun(['pack','--ignore-scripts','--json','--pack-destination',root], pkgRoot));
  const install = join(root,'install'); await mkdir(install);
  await writeFile(join(install,'package.json'),JSON.stringify({name:'research-smoke',private:true,type:'module'}));
  npmRun(['install','--ignore-scripts','--omit=dev','--no-audit','--no-fund',join(root,packed[0].filename)], install);
  const require = createRequire(join(install,'package.json'));
  const manifest = JSON.parse(await readFile(join(pkgRoot,'package.json'),'utf8'));
  const packagePath = join(install,'node_modules',...manifest.name.split('/'));
  const {DefaultResourceLoader} = await import(pathToFileURL(join(install,'node_modules','@earendil-works','pi-coding-agent','dist','index.js')).href);
  const agentDir=join(root,'agent'); const cwd=join(root,'cwd');
  await mkdir(agentDir); await mkdir(cwd);
  await writeFile(join(agentDir,'settings.json'),JSON.stringify({packages:[packagePath]}));
  const loader=new DefaultResourceLoader({agentDir,cwd,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true});
  await loader.reload();
  const loaded=loader.getExtensions(); assert.deepEqual(loaded.errors,[]);
  const tools=loaded.extensions.flatMap(extension=>[...extension.tools.keys()]);
  assert.equal(tools.length,17); assert.equal(new Set(tools).size,17);
  assert.match(await readFile(join(packagePath,'skills','research-kit','SKILL.md'),'utf8'),/name: research-kit/);
  const native=require.resolve(`@ketch-cli/${process.platform}-${process.arch}/bin/${process.platform==='win32'?'ketch.exe':'ketch'}`);
  const version=spawnSync(native,['--version'],{encoding:'utf8',timeout:10000});
  assert.equal(version.status,0); assert.match(version.stdout,/0\.17\.1/);
  console.log('Production tarball: 17 unique tools, packaged skill, pinned native Ketch verified.');
} finally { await rm(root,{recursive:true,force:true}); }
