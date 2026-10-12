import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTranscriptFetcher } from '../src/research/transcripts.ts';
import { SourceAdapterError } from '../src/research/sources.ts';

async function fixture(body:string){
  const root=await mkdtemp(join(tmpdir(),'transcript-fixture-'));
  const helper=join(root,'helper.mjs');
  await writeFile(helper,`import {writeFileSync} from 'node:fs';\nimport {dirname,join} from 'node:path';\nimport {fileURLToPath} from 'node:url';\nconst args=process.argv.slice(2);\nconst dir=dirname(args[args.indexOf('--output')+1]);\nconst fixtureDir=dirname(fileURLToPath(import.meta.url));\n${body}\n`);
  return {root,options:{executable:process.execPath,executableArgs:[helper]}};
}
async function directories(){return (await readdir(tmpdir())).filter(name=>name.startsWith('pi-research-transcript-')).sort();}

test('transcript helper isolates secrets, parses caption dates and cleans private state',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(`if(process.env.RESEARCH_TEST_SECRET)process.exit(23);\nwriteFileSync(join(dir,'fixture.en.vtt'),'WEBVTT\\n\\n00:00:00.000 --> 00:00:01.000\\nA real transcript quote.\\n\\n00:00:01.000 --> 00:00:02.000\\n<b>Second segment.</b>\\n');\nconsole.log(JSON.stringify({title:'Fixture video',upload_date:'20260919'}));`);
  t.after(()=>rm(f.root,{recursive:true,force:true}));
  const before=await directories(); const previous=process.env.RESEARCH_TEST_SECRET;
  process.env.RESEARCH_TEST_SECRET='must-not-be-inherited';
  try{
    const result=await createTranscriptFetcher({...f.options,languages:['en']}).fetch!('https://youtu.be/abcdefghijk') as any;
    assert.equal(result.content,'A real transcript quote. Second segment.');
    assert.equal(result.publishedAt,'2026-09-19T00:00:00.000Z');
    assert.equal(result.dateKind,'upload-date');
    assert.equal(result.segments[1].startSeconds,1);
  }finally{if(previous===undefined)delete process.env.RESEARCH_TEST_SECRET;else process.env.RESEARCH_TEST_SECRET=previous;}
  assert.deepEqual(await directories(),before);
});

test('disabled, unsafe URL, unavailable and oversized captions fail explicitly',{skip:process.platform==='win32'},async t=>{
  const disabled=createTranscriptFetcher();
  await assert.rejects(disabled.fetch!('abcdefghijk'),/disabled/);
  for(const url of ['https://u:p@www.youtube.com/watch?v=abcdefghijk','https://www.youtube.com:8443/watch?v=abcdefghijk']) await assert.rejects(disabled.fetch!(url),error=>error instanceof SourceAdapterError&&error.code==='schema');
  const empty=await fixture(`console.log('{}');`); t.after(()=>rm(empty.root,{recursive:true,force:true}));
  await assert.rejects(createTranscriptFetcher(empty.options).fetch!('abcdefghijk'),/unavailable/i);
  const large=await fixture(`writeFileSync(join(dir,'large.en.vtt'),'WEBVTT\\n'+ 'x'.repeat(100));console.log('{}');`); t.after(()=>rm(large.root,{recursive:true,force:true}));
  await assert.rejects(createTranscriptFetcher({...large.options,maxTranscriptBytes:8}).fetch!('abcdefghijk'),error=>error instanceof SourceAdapterError&&error.code==='output_limit');
});

test('JavaScript transcript fixtures execute portably without a shell',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(`writeFileSync(join(dir,'test.en.vtt'),'WEBVTT\\n\\n00:00:02.000 --> 00:00:03.000\\nCaption\\n');console.log(JSON.stringify({title:'Portable'}));`); t.after(()=>rm(f.root,{recursive:true,force:true}));
  const result=await createTranscriptFetcher(f.options).fetch!('abcdefghijk') as any;
  assert.equal(result.title,'Portable'); assert.equal(result.content,'Caption');
});

test('abort waits for a ready TERM-ignoring helper to exit before cleanup',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(`process.on('SIGTERM',()=>{});writeFileSync(join(fixtureDir,'ready'),String(process.pid));setInterval(()=>writeFileSync(join(dir,'late.en.vtt'),'late'),50);`);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const before=await directories(); const controller=new AbortController();
  const pending=createTranscriptFetcher({...f.options,timeoutMs:10000}).fetch!('abcdefghijk',{signal:controller.signal});
  // Attach rejection handling immediately, even if startup fails.
  const rejected=assert.rejects(pending,error=>error instanceof SourceAdapterError&&error.code==='cancelled');
  let ready=false;
  for(let n=0;n<1000;n++){
    try{await readFile(join(f.root,'ready'));ready=true;break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  controller.abort(); await rejected; assert.ok(ready,'fixture reached its signal handler');
  assert.deepEqual(await directories(),before);
});

test('abort kills same-group independent-stdio descendants before cleanup',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(`import {spawn} from 'node:child_process';
const childCode=\"import {writeFileSync} from 'node:fs';import {join} from 'node:path';const target=process.argv[1];process.on('SIGTERM',()=>{});setTimeout(()=>writeFileSync(join(target,'late.en.vtt'),'late writer'),500);setInterval(()=>{},1000);\";
const child=spawn(process.execPath,['-e',childCode,dir],{stdio:'ignore'});
writeFileSync(join(fixtureDir,'child.pid'),String(child.pid));
process.on('SIGTERM',()=>process.exit(0));
setInterval(()=>{},1000);`); t.after(()=>rm(f.root,{recursive:true,force:true}));
  const before=await directories(); const controller=new AbortController();
  const pending=createTranscriptFetcher({...f.options,timeoutMs:10000}).fetch!('abcdefghijk',{signal:controller.signal});
  const rejected=assert.rejects(pending,error=>error instanceof SourceAdapterError&&error.code==='cancelled');
  let childPid=0;
  for(let n=0;n<1000;n++){
    try{childPid=Number(await readFile(join(f.root,'child.pid'),'utf8'));if(childPid)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  controller.abort(); await rejected; assert.ok(childPid,'descendant started');
  await new Promise(resolve=>setTimeout(resolve,600));
  assert.throws(()=>process.kill(childPid,0));
  assert.deepEqual(await directories(),before);
});

test('Windows transcript execution fails closed until process-tree termination exists',{skip:process.platform!=='win32'},async()=>{
  await assert.rejects(createTranscriptFetcher({executable:process.execPath}).fetch!('abcdefghijk'),error=>error instanceof SourceAdapterError&&error.code==='access_denied'&&/Windows|process-tree/i.test(error.message));
});
