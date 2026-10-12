import type { CommunityComment, Evidence } from './types.ts';
import { canonicalUrl, normalizeDate } from './normalize.ts';

export function isYouTubeUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && ['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(url.hostname); } catch { return false; }
}

/** Preserve validated source quotes/metrics instead of losing them in prose normalization. */
export function attachDepth(item: Evidence, raw: unknown): Evidence {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return item;
  const value = raw as Record<string, unknown>;
  let result = item;
  if (Array.isArray(value.comments)) {
    const comments: CommunityComment[] = [];
    for (const entry of value.comments.slice(0,50)) {
      if (!entry || typeof entry !== 'object') continue;
      const c = entry as Record<string, unknown>;
      const url = typeof c.url === 'string' ? canonicalUrl(c.url) : null;
      if (!url || typeof c.quote !== 'string') continue;
      const metrics: Record<string,number> = {};
      if (c.engagement && typeof c.engagement === 'object') for (const key of ['score','comments']) {
        const metric = (c.engagement as Record<string,unknown>)[key];
        if (typeof metric === 'number' && Number.isFinite(metric)) metrics[key] = metric;
      }
      comments.push({url,quote:c.quote.slice(0,20000),publishedAt:normalizeDate(c.publishedAt),...(typeof c.author === 'string' ? {author:c.author.slice(0,200)} : {}),...(Object.keys(metrics).length ? {engagement:metrics} : {})});
    }
    result = {...result,communityComments:comments};
  }
  if (typeof value.transcript === 'string' && value.transcriptStatus === 'available') {
    const segments: Array<{startSeconds:number;text:string}> = [];
    if (Array.isArray(value.segments)) for (const entry of value.segments.slice(0,1000)) {
      if (!entry || typeof entry !== 'object') continue;
      const s = entry as Record<string,unknown>;
      if (typeof s.startSeconds === 'number' && Number.isFinite(s.startSeconds) && s.startSeconds >= 0 && typeof s.text === 'string') segments.push({startSeconds:s.startSeconds,text:s.text.slice(0,10000)});
    }
    result = {...result,transcript:{url:item.url,text:value.transcript,...(typeof value.language === 'string' ? {language:value.language} : {}),segments}};
  }
  return result;
}
