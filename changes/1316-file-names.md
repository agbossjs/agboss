---
section: Breaking
issue: 1316
---

**Files lose the A2A prefix: `FileDto`, `@File`, `Files`, `FileRepository`, and one `FileError`**
(#1316, part of #498): a local workflow had to import `A2AFileDto`, `A2AFiles` and the `A2AFile*` /
`ModelFile*` error pairs to hold a file at all. A file is now `FileDto` (with `FileDto.fromBytes` /
`FileDto.fromUrl`, replacing `A2AClientFile`) and a DTO field of it is `@File({ prompt })` (or
`@List(FileDto)`), all in `@agboss/core/dto` with `WorkflowFinishFileDto` / `WorkflowFinishFilesDto`
and `FilePayloadSource` (was `A2AFileSource`). The service is `Files` (was `A2AFiles`; `FileToSave`,
`FileReference`), the store contract `FileRepository` (`FileKey`, `FileOwner`, `FileMetadata` with
`sizeBytes: Bytes`, `NewFile`; the suite is `fileContract`), all in the root entry. `AttachmentDto`
is removed: a file is a `FileDto`. The wire's part of a file is `A2APart.fromFile` (was
`A2AClientFile.toPart`).

The two error pairs are one family: `FileError.Refused` (`files.refused`, with `FileRefusal`, now one
enum for the A2A and the model paths), `FileError.Unavailable` (`files.unavailable`, with
`FileUnavailableReason`) and `FileError.Conflict` (`files.conflict`) replace `A2AFileRefusedError`,
`A2AFileUnavailableError`, `A2AFileConflictError`, `ModelFileRefusedError` and
`ModelFileUnavailableError`. `.onError(FileError)` takes all three.

Migration:

- `A2AFileDto` → `FileDto`; `@Nested(A2AFileDto, { prompt })` → `@File({ prompt })`; import from `@agboss/core/dto`;
- `A2AClientFile.fromBytes` / `.fromUrl` → `FileDto.fromBytes` / `FileDto.fromUrl`;
- `A2AFiles` → `Files`, `A2AFileRepository` → `FileRepository`, `a2aFileContract` → `fileContract`;
- `err instanceof A2AFileRefusedError` / `ModelFileRefusedError` → `err instanceof FileError.Refused`, and so for the other two.

`@Application({ a2aFiles })` and `retention.a2aFiles` keep their names until the `@FilePolicy`
rework of #1316.
