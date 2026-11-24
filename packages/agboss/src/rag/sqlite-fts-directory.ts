import { RagScopeError } from "./rag-source.js";
import { RagScope, type RagScopeKey } from "./types.js";

/**
 * What a `directory` callback is asked about: the scope's whole key, as ONE object — never a bare
 * `scopeId` (an owner id or a custom key is unique within a tenant only). `scope` is the `@Rag`'s
 * declared scope; `tenantId` and `scopeId` are `undefined` for `RagScope.Shared`.
 */
export interface SqliteFtsDirectoryKey {
  readonly tenantId: string | undefined;
  readonly scopeId: string | undefined;
  readonly scope: RagScope;
}

/** `SqliteFtsOptions.directory`: one folder, or a function of the scope's whole key. */
export type SqliteFtsDirectory = string | ((key: SqliteFtsDirectoryKey) => string | undefined);

/**
 * The folder of a scope. Under any scope but `Shared` a callback is asked once more for the same
 * scope id in ANOTHER tenant, and must answer a different folder: one that does not is keyed on
 * the scope id alone, and would index two tenants' owners into one directory.
 */
export function folderOf(
  directory: SqliteFtsDirectory,
  { scopeId, tenantId, scope }: RagScopeKey,
): string | undefined {
  if (typeof directory === "string") return directory;
  const kind = scope ?? (tenantId === undefined ? RagScope.Shared : RagScope.Custom);
  const folder = directory({ tenantId, scopeId, scope: kind });
  if (kind === RagScope.Shared || folder === undefined) return folder;
  const probe = `${String(tenantId)}\u0000another-tenant`;
  if (directory({ tenantId: probe, scopeId, scope: kind }) === folder)
    throw new RagScopeError({
      message: `[rag.directory-not-tenant-keyed] SqliteFtsRagSource: the directory callback answers one folder for a ${kind} scope id in two tenants — key it on the whole { tenantId, scopeId } (a scope id alone is unique within a tenant only), or give a plain folder`,
    });
  return folder;
}
