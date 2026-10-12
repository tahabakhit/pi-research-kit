import type { Citation, Evidence } from "./types.ts";
import { deduplicateEvidence, rankEvidence } from "./normalize.ts";

export interface EvidenceComparison {
  left: Evidence;
  right: Evidence;
  sharedTerms: string[];
  differences: string[];
  agreement: "same-source" | "overlapping" | "different";
}

export interface Synthesis {
  summary: string;
  claims: Array<{ text: string; citations: Citation[]; confidence: number }>;
  evidence: Evidence[];
  unknownDate: Evidence[];
  limitations: string[];
}

export interface DiscoveryGroup {
  topic: string;
  evidenceIds: string[];
  sourceCount: number;
  domainCount: number;
  eligible: boolean;
  basis: string;
}

export interface DiscoveryCandidate {
  evidence: Evidence;
  score: number;
  accepted: boolean;
  eligible: boolean;
  corroboration: number;
  sourceCount: number;
  domainCount: number;
  reason: string;
}

export interface DiscoveryOptions {
  minimumConfidence?: number;
  /** Number of independent dated peers required. */
  minimumCorroboration?: number;
  /** Domains are the independence boundary; two URLs on one host count once. */
  minimumDomains?: number;
  cutoff?: string;
  asOf?: string;
  excludedTerms?: ReadonlySet<string>;
}

const STOP_WORDS = new Set([
  "about", "after", "against", "among", "because", "before", "being", "between", "could", "does", "during", "from", "have", "into", "more", "over", "report", "research", "recent", "source", "study", "that", "their", "there", "these", "this", "through", "under", "update", "updates", "what", "when", "where", "which", "with", "would",
]);

function words(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));
}

function meaningfulTokens(value: string, excluded: ReadonlySet<string>): string[] {
  return value.toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word) && !excluded.has(word));
}

function phraseSet(item: Evidence, excluded: ReadonlySet<string>): Set<string> {
  const tokens = meaningfulTokens(`${item.title} ${item.snippet}`, excluded);
  const phrases = new Set<string>();
  // Normalized token n-grams make nominations reproducible and require a
  // multiword/entity-topic signal; removed stopwords mean these are not quotes.
  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index + size <= tokens.length; index += 1) {
      const phrase = tokens.slice(index, index + size).join(" ");
      if (phrase.split(" ").some((term) => STOP_WORDS.has(term))) continue;
      phrases.add(phrase);
    }
  }
  return phrases;
}

function domainOf(item: Evidence): string {
  try {
    const host = new URL(item.url).hostname.toLocaleLowerCase().replace(/^www\./, "");
    // Conservative family boundary: subdomains cannot manufacture independence.
    // Without a public-suffix database this deliberately undercounts co.uk-style
    // and multi-tenant domains rather than claiming unproven corroboration.
    return host.includes(":") || /^\d+(\.\d+){3}$/.test(host) ? host : host.split(".").slice(-2).join(".");
  } catch {
    // A normalized Evidence URL is expected, but an opaque host must never
    // accidentally be counted as independent from a real host.
    return `opaque:${item.source.toLocaleLowerCase()}`;
  }
}

function fingerprint(item: Evidence): string {
  return `${item.title} ${item.snippet}`.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function validDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function dateEligible(item: Evidence, options: DiscoveryOptions): boolean {
  const time = validDate(item.publishedAt);
  if (time === null) return false;
  const cutoff = options.cutoff === undefined ? Number.NEGATIVE_INFINITY : validDate(options.cutoff);
  const asOf = options.asOf === undefined ? Number.POSITIVE_INFINITY : validDate(options.asOf);
  return cutoff !== null && asOf !== null && time >= cutoff && time <= asOf;
}

function thresholds(options: DiscoveryOptions): Required<Pick<DiscoveryOptions, "minimumConfidence" | "minimumCorroboration" | "minimumDomains">> {
  const minimumConfidence = options.minimumConfidence ?? 0.65;
  const minimumCorroboration = options.minimumCorroboration ?? 1;
  const minimumDomains = options.minimumDomains ?? 2;
  if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) throw new Error("minimumConfidence must be between 0 and 1.");
  if (!Number.isInteger(minimumCorroboration) || minimumCorroboration < 0 || minimumCorroboration > 10) throw new Error("minimumCorroboration must be an integer between 0 and 10.");
  if (!Number.isInteger(minimumDomains) || minimumDomains < 1 || minimumDomains > 10) throw new Error("minimumDomains must be an integer between 1 and 10.");
  return { minimumConfidence, minimumCorroboration, minimumDomains };
}

function independentPeers(item: Evidence, candidates: readonly Evidence[], excluded: ReadonlySet<string>): Evidence[] {
  const itemPhrases = phraseSet(item, excluded);
  if (!itemPhrases.size) return [];
  const itemFingerprint = fingerprint(item);
  return candidates.filter((other) => {
    if (other.id === item.id || !dateEligible(other, { cutoff: undefined, asOf: undefined })) return false;
    if (domainOf(other) === domainOf(item)) return false;
    // Identical title/snippet across hosts is a likely syndicated copy. It is
    // retained as evidence but cannot manufacture independent corroboration.
    if (fingerprint(other) === itemFingerprint) return false;
    const overlap = [...itemPhrases].some((phrase) => phraseSet(other, excluded).has(phrase));
    return overlap;
  });
}

/** Group deterministic multiword leads; groups never assert a factual trend. */
export function groupDiscoveryEvidence(evidence: readonly Evidence[], options: DiscoveryOptions = {}): DiscoveryGroup[] {
  const excluded = options.excludedTerms ?? new Set<string>();
  const eligible = deduplicateEvidence(evidence).filter((item) => dateEligible(item, options));
  const groups = new Map<string, Evidence[]>();
  for (const item of eligible) {
    for (const phrase of phraseSet(item, excluded)) {
      const items = groups.get(phrase) ?? [];
      if (!items.some((candidate) => candidate.id === item.id) && !items.some((candidate) => fingerprint(candidate) === fingerprint(item))) items.push(item);
      groups.set(phrase, items);
    }
  }
  const { minimumConfidence, minimumCorroboration, minimumDomains } = thresholds(options);
  return [...groups.entries()]
    .map(([topic, items]) => {
      const distinct = items.filter((item, index) => items.findIndex((candidate) => candidate.id === item.id) === index);
      const domains = new Set(distinct.map(domainOf));
      const sources = new Set(distinct.map((item) => item.source));
      const independent = distinct.length >= 2 && domains.size - 1 >= minimumCorroboration && distinct.every((item) => item.confidence >= minimumConfidence) && domains.size >= minimumDomains;
      return {
        topic,
        evidenceIds: distinct.slice(0, 6).map((item) => item.id),
        sourceCount: sources.size,
        domainCount: domains.size,
        eligible: independent,
        basis: independent
          ? "exact multiword/entity-topic overlap across distinct dated domains; source URLs and dates retained; heuristic lead only"
          : "multiword overlap did not meet the independent dated-domain threshold; no finding asserted",
      };
    })
    .filter((group) => group.evidenceIds.length >= 2)
    .sort((left, right) => right.domainCount - left.domainCount || right.evidenceIds.length - left.evidenceIds.length || left.topic.localeCompare(right.topic))
    .slice(0, 8);
}

export function compareEvidence(left: Evidence, right: Evidence): EvidenceComparison {
  const leftWords = words(`${left.title} ${left.snippet} ${left.content ?? ""}`);
  const rightWords = words(`${right.title} ${right.snippet} ${right.content ?? ""}`);
  const sharedTerms = [...leftWords].filter((term) => rightWords.has(term)).sort();
  const differences: string[] = [];
  if (left.publishedAt !== right.publishedAt) differences.push("publication dates differ or are unknown");
  if (left.source !== right.source) differences.push("sources differ");
  if (domainOf(left) !== domainOf(right)) differences.push("domains differ");
  if (left.title !== right.title) differences.push("titles differ");
  return {
    left,
    right,
    sharedTerms,
    differences,
    agreement: left.source === right.source ? "same-source" : sharedTerms.length >= 3 ? "overlapping" : "different",
  };
}

export function discoverWithConfidence(
  candidates: readonly Evidence[],
  options: DiscoveryOptions = {},
): DiscoveryCandidate[] {
  const all = deduplicateEvidence(candidates);
  const { minimumConfidence, minimumCorroboration, minimumDomains } = thresholds(options);
  const excluded = options.excludedTerms ?? new Set<string>();
  return rankEvidence(all).map((evidence) => {
    const eligible = dateEligible(evidence, options);
    const peers = eligible ? independentPeers(evidence, all, excluded).filter((item) => dateEligible(item, options)) : [];
    const domains = new Set([domainOf(evidence), ...peers.map(domainOf)]);
    const sources = new Set([evidence.source, ...peers.map((item) => item.source)]);
    const corroboration = new Set(peers.map(domainOf)).size;
    const sourceCount = sources.size;
    const domainCount = domains.size;
    const accepted = eligible && evidence.confidence >= minimumConfidence && corroboration >= minimumCorroboration && domainCount >= minimumDomains;
    const reason = !eligible
      ? "date is unknown or outside the requested eligibility window"
      : evidence.confidence < minimumConfidence
        ? `heuristic evidence score ${evidence.confidence.toFixed(2)} is below the ${minimumConfidence.toFixed(2)} threshold`
        : domainCount < minimumDomains
          ? `only ${domainCount} independent domain${domainCount === 1 ? "" : "s"}; ${minimumDomains} required`
          : corroboration < minimumCorroboration
            ? `only ${corroboration} independent corroborating lead${corroboration === 1 ? "" : "s"}; ${minimumCorroboration} required`
            : "dated multiword/entity-topic overlap and independent-domain thresholds met; heuristic lead, not a verified finding";
    return {
      evidence,
      score: evidence.confidence,
      accepted,
      eligible,
      corroboration,
      sourceCount,
      domainCount,
      reason,
    };
  });
}

export function synthesizeEvidence(evidence: readonly Evidence[], query = ""): Synthesis {
  const ranked = rankEvidence(deduplicateEvidence(evidence), query);
  const dated = ranked.filter((item) => item.publishedAt);
  const unknownDate = ranked.filter((item) => !item.publishedAt);
  const accepted = discoverWithConfidence(dated).filter((item) => item.accepted).map((item) => item.evidence);
  const claims = accepted.slice(0, 8).map((item) => ({
    text: `${item.title}${item.snippet ? `: ${item.snippet}` : ""}`,
    citations: [item.citation],
    confidence: item.confidence,
  }));
  const summary = dated.length
    ? `Collected ${dated.length} dated source${dated.length === 1 ? "" : "s"} for ${query || "the research question"}; ${claims.length ? `${claims.length} heuristic lead${claims.length === 1 ? "" : "s"} met explicit corroboration thresholds.` : "no solid findings met the explicit corroboration thresholds."}`
    : `No dated sources were found for ${query || "the research question"}.`;
  return {
    summary,
    claims,
    evidence: dated,
    unknownDate,
    limitations: [
      "This is an evidence-organizing synthesis, not an independently verified conclusion.",
      "Evidence scores are adapter heuristics, not calibrated factual confidence.",
      ...(unknownDate.length ? [`${unknownDate.length} source${unknownDate.length === 1 ? " has" : "s have"} no reliable publication date and remain separate.`] : []),
      ...(!claims.length && dated.length ? ["No solid findings: dated evidence did not meet the multiword, confidence, and independent-domain thresholds."] : []),
    ],
  };
}
