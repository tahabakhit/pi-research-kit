import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRedditAdapter,createYouTubeAdapter} from '../src/research/social-sources.ts';
import {normalizeSearchResponse} from '../src/research/normalize.ts';
import {discoverWithConfidence,groupDiscoveryEvidence} from '../src/research/synthesis.ts';

test('malformed comment responses never become successful empty coverage',async()=>{
  const reddit=createRedditAdapter({fetch:async()=>new Response(JSON.stringify([{},{}]))});
  await assert.rejects(reddit.fetch!('https://www.reddit.com/comments/abc123/'),/malformed|schema/);
  const youtube=createYouTubeAdapter({apiKey:'fixture',fetch:async()=>new Response(JSON.stringify({items:[{}]}))});
  await assert.rejects(youtube.fetch!('https://www.youtube.com/watch?v=abcdefghijk'),/schema/);
});

test('multiple URLs or subdomains cannot manufacture independent corroboration',()=>{
  const evidence=normalizeSearchResponse([
    {url:'https://a.example/one',title:'Battery recycling improves yield',snippet:'Original observation',publishedAt:'2026-09-19'},
    {url:'https://b.example/two',title:'Battery recycling report',snippet:'A separate description',publishedAt:'2026-09-19'},
    {url:'https://news.b.example/three',title:'Battery recycling analysis',snippet:'Another account from the same publisher',publishedAt:'2026-09-19'},
  ]);
  const options={minimumCorroboration:2,minimumDomains:2};
  assert.ok(discoverWithConfidence(evidence,options).every(candidate=>!candidate.accepted));
  assert.ok(groupDiscoveryEvidence(evidence,options).every(group=>!group.eligible));
});
