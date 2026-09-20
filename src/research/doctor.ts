import { access, constants } from "node:fs/promises";
import type { DoctorReport, KetchResearchDeps, SourceAdapter, SourceStatus } from "./types.ts";
import { defaultResearchRoot } from "./library.ts";

const EXPECTED_OPTIONAL_SOURCES = ["x", "youtube", "reddit", "hacker-news", "github", "polymarket"] as const;

export async function doctorResearch(
  deps: Partial<KetchResearchDeps>,
  options: { root?: string; adapters?: readonly SourceAdapter[] } = {},
): Promise<DoctorReport> {
  const stateRoot = options.root ?? defaultResearchRoot();
  let writable = false;
  try { await access(stateRoot, constants.W_OK); writable = true; } catch { writable = false; }
  const sources: SourceStatus[] = [
    { id: "ketch-search", label: "Ketch search", status: deps.search ? "available" : "unconfigured", ...(!deps.search ? { message: "Search dependency was not supplied." } : {}) },
    { id: "ketch-fetch", label: "Ketch fetch", status: deps.fetch ? "available" : "unconfigured", ...(!deps.fetch ? { message: "Fetch dependency was not supplied." } : {}) },
    ...EXPECTED_OPTIONAL_SOURCES.map((id) => ({ id, label: id, status: "unsupported" as const, message: "No typed adapter is registered." })),
    ...(options.adapters ?? []).map((adapter) => ({ id: adapter.id, label: adapter.label, status: adapter.search || adapter.fetch ? "available" as const : "unsupported" as const, ...(!adapter.search && !adapter.fetch ? { message: "Adapter exposes neither search nor fetch." } : {}) })),
  ];
  const notes = [
    "No social or API coverage is claimed without a registered adapter.",
    "Research state defaults outside the checkout; tests should provide a temporary root.",
    "Publication and research handoff require explicit contracts and approval.",
  ];
  if (!writable) notes.push("State root is not writable or does not exist yet; a research write will create it if its parents are safe.");
  return { ok: Boolean(deps.search && deps.fetch), stateRoot, writable, dependencies: { search: Boolean(deps.search), fetch: Boolean(deps.fetch) }, sources, notes };
}
