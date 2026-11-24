import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { extname } from "node:path";
import { checkedCallerId } from "../flow/context/context-values.js";
import type { RagScopeKey } from "./types.js";

/** The key the index holds a `RagScope.Shared` source's one corpus under. */
const SHARED_KEY = "";

/**
 * The key a scope's rows are held under: the pair (tenant, scope id) as JSON — unambiguous, so no
 * crafted id collides with another pair's — or the one key of the shared corpus. A scope with a
 * part missing is no scope: it fails closed, it never reads the shared corpus.
 */
export function keyOf({ tenantId, scopeId }: RagScopeKey): string {
  if (tenantId === undefined && scopeId === undefined) return SHARED_KEY;
  if (tenantId === undefined || scopeId === undefined)
    throw new TypeError(
      "SqliteFtsRagSource: a scope names its tenant and its id, or neither (shared)",
    );
  checkedCallerId("SqliteFtsRagSource", "tenantId", tenantId);
  checkedCallerId("SqliteFtsRagSource", "scopeId", scopeId);
  return JSON.stringify([tenantId, scopeId]);
}

export const scopeOf = (key: string): RagScopeKey => {
  if (key === SHARED_KEY) return {};
  const [tenantId, scopeId] = JSON.parse(key) as [string, string];
  return { tenantId, scopeId };
};

const DOCUMENT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

export const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The Markdown files of a folder, sorted; no folder → none. */
export async function documentsIn(folder: string | undefined): Promise<readonly string[]> {
  if (folder === undefined) return [];
  return (await readdir(folder, { recursive: true }))
    .filter((file) => DOCUMENT_EXTENSIONS.has(extname(file).toLowerCase()))
    .sort();
}
