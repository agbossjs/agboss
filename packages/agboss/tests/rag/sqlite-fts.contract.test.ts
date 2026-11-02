/**
 * #700 AC2 — the reference connector runs the published RAG connector contract
 * (`ragConnectorContract`, `@agboss/core/testing/contracts`): each tenant its own folder (looked up,
 * never built from the id), one index file.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteFtsConnector } from "../../src/rag/sqlite-fts.js";
import { ragConnectorContract } from "../../src/testing/contracts/index.js";

/** The connector of one case and its tenants' folders. */
const folders = new WeakMap<SqliteFtsConnector, Map<string, string>>();
const roots = new WeakMap<SqliteFtsConnector, string>();

ragConnectorContract({
  name: "SqliteFtsConnector",
  connector: async () => {
    const root = await mkdtemp(join(tmpdir(), "fts-contract-"));
    const byTenant = new Map<string, string>();
    const connector = new SqliteFtsConnector({
      folder: (tenantId) => byTenant.get(tenantId),
      dbFile: join(root, "index.sqlite"),
    });
    folders.set(connector, byTenant);
    roots.set(connector, root);
    return connector;
  },
  documents: async (connector, tenantId, documents) => {
    const byTenant = folders.get(connector) ?? new Map<string, string>();
    const folder =
      byTenant.get(tenantId) ?? join(roots.get(connector) ?? tmpdir(), `t${String(byTenant.size)}`);
    byTenant.set(tenantId, folder);
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true });
    for (const document of documents) await writeFile(join(folder, document.source), document.text);
  },
});
