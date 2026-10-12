/**
 * Standalone Pi Research Kit. Registration is inert: retrieval and writes only
 * happen when tools are called; no daemon, installation, or network at startup.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerKetchTools } from "./tools/index.ts";
import { createKetchClient } from "./ketch/client.ts";
import { registerResearchTools, type ResearchToolDeps } from "./research/tools.ts";
import { configuredPublication, configuredResearchAdapters } from "./research/config.ts";
import { registerWorkflowTools } from "./research/workflow-tools.ts";

export default function piResearchKit(pi: ExtensionAPI): void {
  const client = createKetchClient();
  registerKetchTools(pi);
  const deps: ResearchToolDeps = {
    search: (query, options) => client.searchEvidence(query, options),
    fetch: (url, options) => client.fetchEvidence(url, options),
    adapters: configuredResearchAdapters(),
    publication: configuredPublication(),
  };
  registerResearchTools(pi, deps);
  registerWorkflowTools(pi, deps);
}

export { KETCH_TOOL_NAMES, createKetchTools, registerKetchTools } from "./tools/index.ts";
export type { KetchToolDeps } from "./tools/index.ts";
export {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  KETCH_VERSION,
  MAX_CRAWL_DEPTH,
  MAX_CRAWL_PAGES,
  MAX_OUTPUT_BYTES,
  MAX_RESULT_BYTES,
  MAX_RESULT_LINES,
  MAX_URLS,
  KetchCancelledError,
  KetchClient,
  KetchCommandError,
  KetchError,
  KetchTimeoutError,
  boundedInteger,
  createKetchClient,
  fetchEvidence,
  resolveKetchCommand,
  runKetch,
  searchEvidence,
  validateHttpUrl,
} from "./ketch/client.ts";
export type {
  EvidenceItem,
  FetchEvidenceOptions,
  KetchRunOptions,
  KetchRunResult,
  SearchEvidenceOptions,
} from "./ketch/client.ts";
