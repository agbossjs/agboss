---
section: Added
issue: 899
---

**Files reach an agent's model — the core path** (#899 PR 1): `@Agent({ files: ModelFiles.of({
sources, views, maxFileSize, maxTotalFileSize, maxFiles, allowedMediaTypes, … }) })`
(`FileSource.Input` / `ToolResults`, `FileView.Original` / `Transcription`; `defaults.files` on
`@Workflow` / `@Application`, field by field over the skills', `a2aFiles` and the built-in limits;
`megabytes` in `@agboss/core/units`). Images and PDFs ride as content parts (`ModelInputPart`,
written for the wire in `toWireRequest`), text formats as text under a heading; a visit reads each
file once through the guarded path (`files/file-bytes.ts`: origins, address, userinfo, size, digest,
media type) and every model call of the loop carries the same bytes. Limits fail closed before any
call (`ModelFileLimitError`, `step.model-file-limit`); `ModelFileUnavailableError` /
`ModelFileRefusedError`. A transport provider's `ModelProviderMessage.parts`; its
`ModelProviderInputError` and an HTTP provider's 4xx naming an unsupported input are `ModelCallError`
`model.unsupported-input` — never retried, never counted by the breaker, never a fallback.
`ModelCapabilities.inputs` (OpenRouter's `input_modalities`, the decision models'), checked at start
for every kind an agent's files need, its transcriber and every `fallbackModels` target
(`[model.unsupported-input]`); a defaulted set of media types narrows to what the model takes.
`FileTranscriber` / `ModelFileTranscriber` (`files:transcriber`, a model use kind `files`),
`CostCategory.Files` — a new key of `CostReport.byCategory` (breaking for exhaustive readers) —,
cached per file hash in the execution. Assembly rules `[files.invalid-setting]`,
`[files.no-redactor]`, `[pii.original-file]`. `FallbackChatModel` falls back on `model.circuit-open`
only; `GuardFailedError` keeps its `cause`; `mockLlm` requests carry `parts`; a cassette hashes a
part by digest.
