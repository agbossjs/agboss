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
Not yet: the inline cap (1316c), `@FileMasker` / `@FileTranscriber` (1314a).

**Files age by `@FilePolicy({ ttl })`, from the end of the execution.** `ttl: Milliseconds | Ttl.Forever`
(`hours(24)` with no policy); a workflow's policy must set it (`[file-policy.ttl-required-on-workflow]`),
a skill's may only be shorter. A file of an execution that runs or waits paused is never swept — the same
rule as the audit log: the time counts from the end of the root execution's whole tree
(`FileRepository.markOwnerCompleted`, stamped when the tree ends). `Files.save({ ttl })` keeps one file
for less (`FileRefusal.TtlAbovePolicy` for more). The sweep is `FileRepository.deleteExpired({ now,
cutoffsByWorkflow })`, giving the number of files removed (`onTtlSweep`); S3 indexes completed owners
under `completed/<workflow>/<utc time>/…` and files with a ttl of their own under `expires/<utc time>/…`,
so a sweep reads only what is up (`a2aS3Prefix` at most 87 bytes).
Removed: `retention.a2aFiles`, `findOwnersByCreatedAtBefore`, the 60-second orphan sweep (it deleted files
of executions that were no A2A task), the direct-message sweep's removal of its attempts' files.
Added: `FileRepository.{markOwnerCompleted, deleteExpired}`, `FileOwnerCompletion`, `FileSweep`,
`FileMetadata.ttl`, `FileToSave.ttl`, `FileRefusal.TtlAbovePolicy`, `FileUnavailableReason.DigestMissing`.

**The inline cap (1316c).** Bytes held inline in a descriptor ride in checkpoints and records, so
`Files.save` with no `FileRepository` refuses a file over 64 KB (`FileError.Refused`,
`FileRefusal.InlineTooLarge`, no 0.1.0 grandfathering), and `offloadedInlineFiles` (src/files/inline-cap.ts)
moves every inline file over 64 KB — then the largest until a payload's inline bytes fit 256 KB — into the
store under `<ownerId>.<sha256>`, or refuses with no store. Wiring it into `app.execute`, `app.resume` and
tool outputs belongs to the app lane (src/app/**), not yet done.

**Orphans.** Files of an owner that was never marked completed (a crashed upload, an attempt that ran no
tree) are removed by `FileRepository.deleteOrphans({ createdBefore, isLive })`: all the owner's files older
than 30 minutes, no execution record and no A2A task for it, never a live or completed owner's. An accept
that loses its race (`MessageTaken`, `TaskIdTaken`) removes the files it kept for its task.

**`A2AClient.downloadFile` under a `@FilePolicy`.** `new A2AClient({ filePolicy: X })`: a download is capped at
the policy's `maxFileSize` (never above the call's `maxSize`; past it the read stops: `FileUnavailableReason.TooLarge`),
ends at its `fetchTimeout`, and runs in the client's own pool — the policy's `fetchPool`, else the default
16 / 4 / 2 + 8 per client. A full pool is `FileError.Unavailable` (`FetchBusy`), never an unbounded fetch.
Added: `A2AClientOptions.filePolicy`.
