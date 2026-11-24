---
section: Breaking
issue: 1316
---

**`@FilePolicy` is the one place a workflow's files are bounded** (#1316, part of #498): how many
files (`maxFiles`), how large (`maxFileSize`, `maxTotalFileSize`), of which media types
(`allowedMediaTypes`), fetched from which origins (`allowedOrigins`), for how long (`fetchTimeout`)
and in which pool (`fetchPool`) — one class, `@FilePolicy({ … })`, named by `filePolicy: X` on
`@Workflow`. The A2A skills' input, a step's `Files.save`, `Files.read` of a file by url, an
agent's model files and a model's read of a file by url all read their workflow's policy. A workflow
that takes or gives a `FileDto` or reads files with an agent and names no policy fails assembly
(`[workflow.file-policy-required]`); a skill's own `filePolicy` (on `@A2AExpose({ skills })`) may only
tighten its workflow's (`[a2a.skill-file-policy-exceeds-workflow]`); a policy's fields are checked
(`[file-policy.invalid]`, `[file-policy.not-a-file-policy]`).

**One fetch pool.** `fetchPool: { maxConcurrent: 16, maxConcurrentPerTenant: 4, maxConcurrentPerOwner: 2,
maxQueuedPerOwner: 8 }` bounds the fetches of files by url on every path — an `a2aHttpListener`'s
admission, `Files.read`, a model's read. A policy with none shares the application's default pool; one
with its own gets a bulkhead of its own. An execution with no owner uses its tenant's share directly
(it no longer shares one fake owner's bucket, #1339); an owner holds 2 of its tenant's slots (at
most half of them), not 1 (#1339). A pool that is full fails the fetch at once with
`FileError.Unavailable` (`FileUnavailableReason.FetchBusy`, code `files.unavailable`); on the A2A
wire it is still `-32602 a2a.file-fetch-busy`. `Files.read` fetches a file by url through the
policy instead of refusing it.

Removed: `@Application({ a2aFiles })` and `A2AFileOptions`, `@A2AExpose({ skills: { [id]: { files } } })`,
`a2aHttpListener`'s `fileFetchTimeout`, `maxConcurrentFileFetches`, `…PerTenant`, `…PerOwner`,
`[a2a.file-fetch-limit-invalid]`, `FileUnavailableReason.ByReference`.
Added: `@FilePolicy`, `FilePolicyOptions`, `FilePolicyMeta`, `FileFetchPool`, `filePolicy` on `@Workflow`
and on a skill, `FileUnavailableReason.FetchBusy`.
Not yet: `ttl` (with the retention part), the inline cap (1316c), `@FileMasker` / `@FileTranscriber` (1314a).
