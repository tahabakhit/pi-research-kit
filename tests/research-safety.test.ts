import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalResearchLibrary } from '../src/research/library.ts';
import { createResearchTools } from '../src/research/tools.ts';
import { handoffResearchProposal } from '../src/research/proposal.ts';

test('state files are owner-only and immutable', async t => {
  const root=await mkdtemp(join(await realpath(tmpdir()),'research-permissions-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const library=new LocalResearchLibrary(root);
  const record={id:'fixture',title:'Private',summary:'Private',content:'Private',createdAt:'2026-01-01',updatedAt:'2026-01-01',evidence:[],coverage:[]};
  await library.save(record);
  if(process.platform!=='win32'){
    assert.equal((await stat(join(root,'library'))).mode & 0o777,0o700);
    assert.equal((await stat(join(root,'library','fixture.json'))).mode & 0o777,0o600);
  }
  await assert.rejects(()=>library.save({...record,content:'overwrite'}),/overwrite/);
});

test('model approval cannot authorize research handoff writes; human confirmation is required', async t => {
  const root=await mkdtemp(join(await realpath(tmpdir()),'research-consent-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const inbox=join(root,'operator-inbox');
  const tools=createResearchTools({search:async()=>[],fetch:async()=>({}),handoff:{inboxDir:inbox},library:new LocalResearchLibrary(join(root,'state'))});
  const tool=tools.find(tool=>tool.name==='research_handoff')!;
  const params={summary:'Unreviewed research',date:'2026-09-20',confidence:0.5,affectedArea:'Research',changedFiles:[],coverage:['limited'],sourceUrls:['https://example.com'],approved:true};
  const signal=new AbortController().signal;
  const ctx=(hasUI:boolean,answer:boolean)=>({hasUI,mode:hasUI?'interactive':'print',signal,ui:{confirm:async()=>answer}}) as any;
  await assert.rejects(()=>tool.execute('x',params,signal,undefined,ctx(false,true)),/confirmation/);
  await assert.rejects(()=>tool.execute('x',params,signal,undefined,ctx(true,false)),/cancelled/);
  await assert.rejects(()=>stat(inbox),/ENOENT/);
  const result=await tool.execute('x',params,signal,undefined,ctx(true,true));
  const details=result.details as {path:string};
  assert.match(details.path,/2026-09-20-research-.*\.md$/);
  assert.match(await readFile(details.path,'utf8'),/## Source \/ evidence/);
});

test('Research handoff accepts an arbitrary explicit inbox path', async t => {
  const root=await mkdtemp(join(await realpath(tmpdir()),'research-curated-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const result=await handoffResearchProposal({inboxDir:join(root,'wiki')},{summary:'test',date:'2026-09-20',confidence:0.5,affectedArea:'Research',sources:[{id:'s',title:'Source',url:'https://example.com',source:'web',publishedAt:null}],coverage:[],changedFiles:[]},{approved:true});
  assert.equal(result.status,'written');
});

test('Research handoff rejects a relative inbox path', async t => {
  await assert.rejects(()=>handoffResearchProposal({inboxDir:'relative-inbox'},{summary:'test',date:'2026-09-20',confidence:0.5,affectedArea:'Research',sources:[{id:'s',title:'Source',url:'https://example.com',source:'web',publishedAt:null}],coverage:[],changedFiles:[]},{approved:true}),/absolute inbox path/);
});
