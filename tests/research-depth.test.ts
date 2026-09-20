import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRecentResearch } from '../src/research/research.ts';
import { configuredResearchAdapters } from '../src/research/config.ts';

const url='https://www.youtube.com/watch?v=abcdefghijk';
const deps={search:async()=>[],fetch:async()=>{throw new Error('generic page fetch must not replace depth adapters');}};
function adapters(calls:string[]){return [
  {id:'youtube',label:'Video',search:async()=>[{url,title:'Original video title',publishedAt:'2026-09-19T00:00:00Z'}],fetch:async()=>{calls.push('comments');return {title:'Comments page',content:'Actual comment',comments:[{author:'reader',quote:'Actual comment',url:url+'&lc=comment-id',publishedAt:'2026-09-19T01:00:00Z',engagement:{score:7}}]};}},
  {id:'youtube-transcript',label:'Transcript',fetch:async()=>{calls.push('transcript');return {url,content:'Actual captions',transcript:'Actual captions',transcriptStatus:'available',segments:[{startSeconds:2,text:'Actual captions'}]};}},
];}

test('depth adapters preserve captions, comments, metrics and source title',async()=>{
  const calls:string[]=[];
  const result=await runRecentResearch(deps,'video',{adapters:adapters(calls),maxFetch:2,limit:5,now:new Date('2026-09-20T00:00:00Z')});
  assert.deepEqual(calls,['transcript','comments']);
  assert.equal(result.recent[0]?.title,'Original video title');
  assert.equal(result.recent[0]?.transcript?.segments[0]?.startSeconds,2);
  assert.equal(result.recent[0]?.communityComments?.[0]?.engagement?.score,7);
  assert.equal(result.recent[0]?.communityComments?.[0]?.url,url+'&lc=comment-id');
});

test('depth adapters share the fetch budget and caption failure remains explicit',async()=>{
  const calls:string[]=[];
  const result=await runRecentResearch(deps,'video',{adapters:adapters(calls),maxFetch:1,limit:5,now:new Date('2026-09-20T00:00:00Z')});
  assert.deepEqual(calls,['transcript']);
  assert.equal(result.recent[0]?.communityComments,undefined);
  const broken=adapters([]); broken[1]!.fetch=async()=>{throw new Error('No captions');};
  const partial=await runRecentResearch(deps,'video',{adapters:broken,maxFetch:2,limit:5,now:new Date('2026-09-20T00:00:00Z')});
  assert.equal(partial.statuses.find(s=>s.id==='youtube-transcript')?.status,'failed');
  assert.equal(partial.recent[0]?.communityComments?.length,1);
});

test('transcripts require explicit operator opt-in and a configured executable',()=>{
  assert.ok(!configuredResearchAdapters({PI_RESEARCH_YTDLP_BIN:'/fixture/helper'}).some(a=>a.id==='youtube-transcript'));
  assert.ok(configuredResearchAdapters({PI_RESEARCH_ENABLE_TRANSCRIPTS:'1',PI_RESEARCH_YTDLP_BIN:'/fixture/helper'}).some(a=>a.id==='youtube-transcript'));
});
