---
section: Added
issue: 899
---

**Redacted copies, history files, audio and video, and `files` in describe** (#899 PR 3):
`FileRedactor` (`supports(mediaType)`, `redact(file, { targets, values, signal, tenantId })`) with the
built-in `ModelImageRedactor` — a cheap vision model names the regions (`defaults.files.redactionModel`), `sharp`
(an **optional peer dependency**) turns the image upright (EXIF orientation applied), refuses a multi-frame
image and one over 40 megapixels, and paints the regions, padded 10 %, black in a copy without metadata (png,
jpeg, webp). `FileView.Redacted` gives the model that copy under the agent's PII policies. Where a policy has a
block rule an image is refused whole (`PiiRefusedError`) unless the policy says
`PiiFileAction.RedactWithModel` — a model's judgement of an image is a guardrail, not a guarantee; then a kind a
block rule names that it finds refuses the file, an empty or malformed answer fails closed, and the exact PII
values reach the redaction model only on the agent's own provider or `defaults.files.redactionValues:
RedactionValues.Always`. The start rule `[files.redactor-values-withheld]` and a run-time backstop keep values that cannot be sent from
leaving an unchanged re-encode as the redacted copy. Any other failure (`FileRedactionFailedError`,
`step.file-redaction-failed`) fails closed — never the unredacted file — and what a model wrote is in no error
message, log or cause. A copy is made once per execution (the file store when one is listed, else inline up to
64 KB). Start rules `[files.no-redactor]` (a type no redactor `supports`; the built-in needs `sharp`) and
`[files.redacted-needs-store]`; `mockLlm(FileRedactor)`, spend under `files:redactor`.

`FileSource.History`: the files of the turns the agent remembers, each read as a copy under the executing
root execution when it belongs to a root execution of the same tenant and thread, `(removed)` once retention
took it; `[files.history-needs-store]`. Audio (`audio/mpeg|wav|ogg|flac|aac|mp4`) and video
(`video/mp4|quicktime|webm|x-matroska`) as parts (`input_audio`, `video_url`) with magic-byte checks, the
limits and the start checks of images. `agboss describe` prints each agent's files and `describe --json` has
`AgentSnapshot.files`; the config hash covers a policy's file action. Examples: `invoice-workflow`,
`kyc-workflow` and `audio-note-workflow` in `examples/flow-patterns`; guide: Files for models, ADR-0036.
