---
section: Breaking
issue: 1318
---

**The `filePolicies` shelf and the `filePolicy` slot of a profile, one carrier of the components' options** (#1318, part 1318c).

- `filePolicies: { "<policy name>": { ttl, maxFiles, maxFileSize, maxTotalFileSize, allowedMediaTypes, allowedOrigins,
fetchTimeout, fetchPool } }` in a `defineConfig` / `.config.yaml` profile, and `workflows: { "<name>": { filePolicy:
SomePolicy } }` in a `.config.ts`: a file limit is the same on every path that reads it — `Files.save` / `Files.read`,
  the inline offload, the file expiry, the A2A skills and the storage tier, the assembly rules and an agent's files.
- `ComponentOptions` (internal): ONE carrier of the effective options of the components per assembly, held by the
  application's container and `AssembledApplication.componentOptions`. A component class stays its own identity:
  nothing derives a subclass and no declared class or record is changed. Every reader asks the carrier.
- A policy name the application does not use is a `ProfileError`; so is an overlay that leaves the policy invalid
  (`maxFileSize` above `maxTotalFileSize`, an origin that is not `https:`, a limit of 0). A workflow that takes files
  and declares no policy satisfies `[workflow.file-policy-required]` through the slot.
- Removed: `workflowFilePolicyOf` (now `declaredFilePolicyOf`: the declaration only); `FileLevels.filePolicy` (now
  `FileLevels.limits`).
