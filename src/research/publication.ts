import type { LibraryRecord, PublicationContract } from "./types.ts";

export interface PublicationPreview {
  provider: string;
  destination: string;
  contentHash: string;
  [key: string]: unknown;
}

export interface PublicationAuthorization {
  readonly destination: string;
  readonly contentHash: string;
}

interface PreviewablePublicationContract extends PublicationContract {
  preview(record: LibraryRecord): PublicationPreview;
}

const issuedAuthorizations = new WeakSet<object>();

function previewContract(contract: PublicationContract): PreviewablePublicationContract | undefined {
  const candidate = contract as PublicationContract & { preview?: unknown };
  return typeof candidate.preview === "function" ? candidate as PreviewablePublicationContract : undefined;
}

/**
 * Return the provider's exact local-only destination and artifact digest.
 * Providers must implement preview without network or local file access.
 */
export function getPublicationPreview(record: LibraryRecord, contract: PublicationContract | undefined): PublicationPreview | undefined {
  const previewer = contract && previewContract(contract);
  if (!previewer) return undefined;
  const preview = previewer.preview(record);
  if (!preview || typeof preview.destination !== "string" || !preview.destination || typeof preview.contentHash !== "string" || !preview.contentHash) {
    throw new Error("Publication preview is invalid.");
  }
  return preview;
}

/** Bind the human confirmation to the exact preview shown by the parent tool. */
export function authorizePublication(preview: PublicationPreview): PublicationAuthorization {
  if (!preview || typeof preview.destination !== "string" || !preview.destination || typeof preview.contentHash !== "string" || !preview.contentHash) {
    throw new Error("Cannot authorize an invalid publication preview.");
  }
  const authorization = Object.freeze({ destination: preview.destination, contentHash: preview.contentHash });
  issuedAuthorizations.add(authorization);
  return authorization;
}

export async function publishResearch(
  record: LibraryRecord,
  contract: PublicationContract | undefined,
  options: { approved?: boolean; authorization?: PublicationAuthorization; signal?: AbortSignal } = {},
): Promise<{ status: "published" | "failed" | "skipped"; message: string; reference?: string }> {
  if (options.approved === false) return { status: "skipped", message: "Publication is opt-in; approval was not provided." };
  if (!contract) return { status: "failed", message: "No configured publication contract. No provider was guessed or contacted." };
  if (!contract.id.trim() || !contract.label.trim()) return { status: "failed", message: "Publication contract is invalid." };

  // A boolean is deliberately insufficient. The parent tool must show this
  // exact preview, obtain UI confirmation, and mint the opaque authorization.
  const preview = getPublicationPreview(record, contract);
  if (!preview) return { status: "failed", message: "Publication requires a provider preview bound to human confirmation." };
  const authorization = options.authorization;
  if (!authorization || !issuedAuthorizations.has(authorization as object)) {
    return { status: "failed", message: "Publication requires exact-preview human authorization; the approval boolean alone is insufficient." };
  }
  if (authorization.destination !== preview.destination || authorization.contentHash !== preview.contentHash) {
    return { status: "failed", message: "Publication authorization does not match the current destination or content." };
  }

  issuedAuthorizations.delete(authorization as object);
  if (options.signal?.aborted) return { status: "skipped", message: "Publication cancelled before upload." };
  const result = await contract.publish(record, { signal: options.signal });
  return {
    status: result.status,
    message: result.message ?? (result.status === "published" ? `Published via ${contract.label}.` : `Publication via ${contract.label} failed.`),
    ...(result.reference ? { reference: result.reference } : {}),
  };
}
