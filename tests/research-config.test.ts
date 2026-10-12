import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredPublication, configuredResearchAdapters } from '../src/research/config.ts';

test('credentialed sources require both explicit opt-in and dedicated credentials',()=>{
  const defaults=configuredResearchAdapters({GH_TOKEN:'ambient',GOOGLE_API_KEY:'ambient',PI_RESEARCH_X_BEARER_TOKEN:'not-enabled'}).map(adapter=>adapter.id);
  assert.deepEqual(defaults,['hacker-news','github','reddit','polymarket']);
  const opted=configuredResearchAdapters({PI_RESEARCH_ENABLE_X:'1',PI_RESEARCH_X_BEARER_TOKEN:'fixture',PI_RESEARCH_ENABLE_YOUTUBE:'1',PI_RESEARCH_YOUTUBE_API_KEY:'fixture'}).map(adapter=>adapter.id);
  assert.ok(opted.includes('x')); assert.ok(opted.includes('youtube'));
});

test('publishing never infers a repository or uses ambient GitHub auth',()=>{
  assert.equal(configuredPublication({GH_TOKEN:'ambient'}),undefined);
  assert.equal(configuredPublication({PI_RESEARCH_PUBLISH_GITHUB:'1',GH_TOKEN:'ambient'}),undefined);
  const configured=configuredPublication({PI_RESEARCH_PUBLISH_GITHUB:'1',PI_RESEARCH_PUBLISH_OWNER:'fixture',PI_RESEARCH_PUBLISH_REPO:'research',PI_RESEARCH_PUBLISH_BRANCH:'gh-pages',PI_RESEARCH_PUBLISH_PREFIX:'reports',PI_RESEARCH_PUBLISH_TOKEN:'fixture'});
  assert.equal(configured?.id,'github-pages');
});
