import { resolve } from "node:path";
import type { LibraryRecord } from "./types.ts";
import { atomicCreate, ensureSafeDirectory } from "./library.ts";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function safeHref(value: string): string {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? escapeHtml(url.toString()) : "#";
  } catch {
    return "#";
  }
}

export function renderLibraryHtml(records: readonly LibraryRecord[], title = "Research Library"): string {
  const cards = records.map((record) => {
    const sources = record.evidence.map((item) => `<li><a href="${safeHref(item.url)}">${escapeHtml(item.title)}</a> — ${escapeHtml(item.publishedAt ?? "date unknown")}</li>`).join("");
    return `<article><h2>${escapeHtml(record.title)}</h2><p>${escapeHtml(record.summary)}</p><div>${escapeHtml(record.content)}</div><h3>Sources</h3><ul>${sources || "<li>No sources</li>"}</ul></article>`;
  }).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${cards}</body></html>`;
}

function escapeXml(value: string): string {
  return escapeHtml(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "\ufffd"));
}

export async function writeLibraryHtml(path: string, records: readonly LibraryRecord[], title = "Research Library"): Promise<void> {
  await writeExport(path, renderLibraryHtml(records, title));
}

export async function writeLibraryAtom(path: string, records: readonly LibraryRecord[], feedTitle = "Research Library", feedUrl = "urn:pi-research-kit"): Promise<void> {
  await writeExport(path, renderAtom(records, feedTitle, feedUrl));
}

async function writeExport(path: string, content: string): Promise<void> {
  const absolute = resolve(path);
  await ensureSafeDirectory(resolve(absolute, ".."));
  await atomicCreate(absolute, content);
}

export function renderAtom(records: readonly LibraryRecord[], feedTitle = "Research Library", feedUrl = "urn:pi-research-kit"): string {
  const updated = records.map((record) => record.updatedAt).sort().at(-1) ?? new Date(0).toISOString();
  const entries = records.map((record) => {
    const links = record.evidence.map((item) => `<link rel="related" href="${safeHref(item.url)}"/>`).join("");
    return `<entry><id>urn:pi-research-kit:${escapeXml(record.id)}</id><title>${escapeXml(record.title)}</title><updated>${escapeXml(record.updatedAt)}</updated>${links}<summary type="text">${escapeXml(record.summary)}</summary><content type="text">${escapeXml(record.content)}</content></entry>`;
  }).join("");
  return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>${escapeXml(feedUrl)}</id><title>${escapeXml(feedTitle)}</title><author><name>Research Kit</name></author><updated>${escapeXml(updated)}</updated>${entries}</feed>`;
}
