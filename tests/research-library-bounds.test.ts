import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, mkdir, writeFile, truncate, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIBRARY_LIMITS, LocalResearchLibrary } from '../src/research/library.ts';

async function fixture(t:any){const root=await mkdtemp(join(await realpath(tmpdir()),'library-bounds-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,library:new LocalResearchLibrary(root)};}
const record={id:'test',title:'Test',summary:'Summary',content:'Body',createdAt:'2026-09-20T00:00:00Z',updatedAt:'2026-09-20T00:00:00Z',evidence:[],coverage:[]};

test('oversized and identity-mismatched library records fail before consumption',async t=>{
  const {root,library}=await fixture(t);await library.init();
  const path=join(root,'library','test.json');
  await writeFile(path,'');await truncate(path,LIBRARY_LIMITS.recordBytes+1);
  await assert.rejects(()=>library.get('test'),/read limit/);
  await writeFile(path,JSON.stringify({...record,id:'different'}));
  await assert.rejects(()=>library.get('test'),/identity/);
});

test('interrupted-save locks are preserved and Markdown orphans are not indexed',async t=>{
  const {root,library}=await fixture(t);await library.init();
  await writeFile(join(root,'library','orphan.md'),'uncommitted');
  assert.deepEqual(await library.list(),[]);
  const lock=join(root,'library','test.json.lock');await mkdir(lock);
  await assert.rejects(()=>library.save(record),/concurrent/);
  assert.ok((await stat(lock)).isDirectory());
  await assert.rejects(()=>stat(join(root,'library','test.json')),/ENOENT/);
});
