import { createDefaultSourceAdapters } from './sources.ts';
import { createGitHubPublication } from './github-publish.ts';
import { createTranscriptFetcher } from './transcripts.ts';
import type { PublicationContract, SourceAdapter } from './types.ts';

/** Operator opt-ins only; never consult ambient GH_TOKEN, X tokens, or Google keys. */
export function configuredResearchAdapters(env: NodeJS.ProcessEnv = process.env): readonly SourceAdapter[] {
  const adapters = [...createDefaultSourceAdapters({
    ...(env.PI_RESEARCH_ENABLE_X === '1' && env.PI_RESEARCH_X_BEARER_TOKEN ? {xBearerToken:env.PI_RESEARCH_X_BEARER_TOKEN} : {}),
    ...(env.PI_RESEARCH_ENABLE_YOUTUBE === '1' && env.PI_RESEARCH_YOUTUBE_API_KEY ? {youtubeApiKey:env.PI_RESEARCH_YOUTUBE_API_KEY} : {}),
  })];
  if (env.PI_RESEARCH_ENABLE_TRANSCRIPTS === '1' && env.PI_RESEARCH_YTDLP_BIN) adapters.push(createTranscriptFetcher({ executable: env.PI_RESEARCH_YTDLP_BIN }));
  return adapters;
}

export function configuredPublication(env: NodeJS.ProcessEnv = process.env): PublicationContract | undefined {
  if (env.PI_RESEARCH_PUBLISH_GITHUB !== '1') return undefined;
  const owner=env.PI_RESEARCH_PUBLISH_OWNER;
  const repo=env.PI_RESEARCH_PUBLISH_REPO;
  const branch=env.PI_RESEARCH_PUBLISH_BRANCH;
  const token=env.PI_RESEARCH_PUBLISH_TOKEN;
  const pathPrefix=env.PI_RESEARCH_PUBLISH_PREFIX;
  if (!owner || !repo || !branch || !token || !pathPrefix) return undefined;
  return createGitHubPublication({owner,repo,branch,token,pathPrefix});
}
