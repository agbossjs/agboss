---
section: Breaking
issue: 1318
---

**Profile shelves for the database storage and the mesh** (#1318, part 1318c).

- `databaseStorages: { "<storage name>": { auditLogTtl, ledgerEntriesTtl } }` and `mesh: { "<mesh name>":
  { deduplicationTtl, maxHops, envelopeTtl, maxClockSkew } }` in a `defineConfig` / `.config.yaml` profile: the
  application's retentions, mesh answer retention, hop cap and signature windows read the profile's values (one
  derived class per class and overlay; the declared class is never changed). A name the application does not
  have is a `ProfileError` naming the key.
