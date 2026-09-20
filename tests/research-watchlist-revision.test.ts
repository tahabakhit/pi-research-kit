import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResearchWatchlist} from '../src/research/watchlist.ts';

test('stale watchlist approval cannot silently research a changed topic',async t=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'watch-revision-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const watch=new ResearchWatchlist(root);const approved=await watch.add('Approved topic');
  await watch.update(approved.id,{query:'Changed topic'});
  let calls=0;
  await assert.rejects(()=>watch.refresh(approved.id,{search:async()=>{calls++;return [];},fetch:async()=>({})},{expected:approved}),/changed since confirmation/);
  assert.equal(calls,0);
});
