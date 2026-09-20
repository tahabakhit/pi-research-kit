import { createHash } from "node:crypto";
import { isAbsolute, resolve, join } from "node:path";
import type { ResearchHandoffConfig, ResearchProposal } from "./types.ts";
import { atomicCreate, ensureSafeDirectory } from "./library.ts";

function validateProposal(proposal: ResearchProposal): void {
  if (!proposal.summary.trim()) throw new Error("Research proposal requires a summary.");
  if (!proposal.affectedArea.trim()) throw new Error("Research proposal requires an affected area.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(proposal.date) || !Number.isFinite(Date.parse(proposal.date))) throw new Error("Research proposal requires a YYYY-MM-DD date.");
  for (const source of proposal.sources) {
    const url = new URL(source.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Research evidence requires HTTP(S) source URLs without credentials.");
  }
  if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) throw new Error("Research proposal confidence must be between 0 and 1.");
  if (!Array.isArray(proposal.sources) || !proposal.sources.length) throw new Error("Research proposal requires at least one source.");
  if (!Array.isArray(proposal.changedFiles)) throw new Error("Research proposal requires changed files, even when the list is empty.");
  if (!Array.isArray(proposal.coverage)) throw new Error("Research proposal requires coverage.");
}

/** Read only an explicit operator-provided inbox setting; never inspect a vault. */
export function handoffConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): ResearchHandoffConfig {
  const inboxDir = env.PI_RESEARCH_INBOX?.trim();
  return inboxDir ? { inboxDir } : {};
}

export async function handoffResearchProposal(
  config: ResearchHandoffConfig,
  proposal: ResearchProposal,
  options: { approved?: boolean; signal?: AbortSignal } = {},
): Promise<{ status: "written" | "skipped" | "failed"; path?: string; message: string }> {
  if (!options.approved) return { status: "skipped", message: "Research handoff is opt-in; approval was not provided." };
  validateProposal(proposal);
  if (!config.inboxDir) return { status: "failed", message: "No user-configured research inbox is configured; no file was written." };
  if (options.signal?.aborted) return { status: "skipped", message: "Research handoff was cancelled." };
  if (!isAbsolute(config.inboxDir)) throw new Error("Research handoff requires an absolute inbox path.");
  const inbox = resolve(config.inboxDir);
  await ensureSafeDirectory(inbox);
  if (options.signal?.aborted) return { status: "skipped", message: "Research handoff was cancelled." };
  const fingerprint = createHash("sha256").update(JSON.stringify(proposal)).digest("hex").slice(0, 16);
  const path = join(inbox, `${proposal.date}-research-${fingerprint}.md`);
  const payload = [
    "# Research proposal", "", "## Summary", proposal.summary,
    "", "## Source / evidence", ...proposal.sources.map(source => `- ${source.title}: ${source.url} (published: ${source.publishedAt ?? "unknown"})`),
    "", "## Date", proposal.date, "", "## Confidence", String(proposal.confidence),
    "", "## Affected area", proposal.affectedArea,
    "", "## Changed files", ...(proposal.changedFiles.length ? proposal.changedFiles.map(path => `- ${path}`) : ["None."]),
    "", "## Coverage limitations", ...proposal.coverage.map(item => `- ${item}`),
    "", "Unreviewed proposal. No curated knowledge or ledgers were modified.", ""
  ].join("\n");
  try {
    await atomicCreate(path, payload);
  } catch (error) {
    if (error instanceof Error && /overwrite existing|unsafe existing/.test(error.message)) {
      return { status: "failed", path, message: "Refusing to overwrite an existing research proposal file." };
    }
    throw error;
  }
  return { status: "written", path, message: "Wrote a new proposal to the configured research inbox." };
}
