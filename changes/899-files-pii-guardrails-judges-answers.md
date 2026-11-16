---
section: Added
issue: 899
---

**Files under PII policies, guardrails, judges and answers** (#899 PR 2): `@PiiPolicy({ files:
PiiFileAction.Mask | PiiFileAction.AllowOriginal })` (default `Mask`). A transcription — and a text
format's own text — is masked by the agent's policies where it is made, a block rule refusing before
anything is kept or sent (an input file fails the execution, as the text does; a tool-result file rejects
that call and the model reads the refusal as its result); only the masked text is kept in the execution's
state, keyed by the policies that masked it (their fingerprint), so it is never reused across another set
of policies, execution or tenant, and the tokens it introduced join the execution's `piiTokens`.
`FileView.Original` starts only where every applying policy says `AllowOriginal` (`[pii.original-file]`);
`FileView.Redacted` under a policy of a project's own detector is `[pii.redacted-needs-kinds]`. PII reads
text only: `image_url` / `file` / `input_audio` / `video_url` blocks are never handed to the mask or a
detection model.

Input guardrails check the content and — with `guardToolResultFiles` (default true) — the files of each
tool result, in the views the agent's model got: a model guardrail reads them as parts (a decision model
png, jpeg and webp images and text), a code guardrail's optional `checkContent(content: GuardrailContent)`
gets the text and the files (without it, `check(text)` gets the text and the text of the files). A block
on a tool result's files rejects that call, a guardrail that cannot decide fails the step; either way a
decision lands in the step's `guardrailDecisions`. `JudgeInput.files` holds the views the model read, and
`judgeModel.invoke` / `decide` carry them as parts. Output guardrails check the files of the answer in
the views the model saw; no LLM guardrail is ever shown base64. A guardrail's or a judge's model that
cannot take a file's kind (a gif or a PDF on a decision model, a text-only chat model) is
`[model.unsupported-input]` at start where its provider reports input kinds, and a defaulted set of media
types narrows to what every model that reads an agent's files takes.

`AnswerFiles`: an agent's answer files are picked by number — `{ file: <n> }` in the answer tool's schema,
files numbered once per visit across fields and sources — and mapped back to the descriptor the framework
holds (`AnswerFiles.SeenInVisit`, the default; the original only if `FileView.Original` was among the
views); `AnswerFiles.Any` takes the model's own descriptors, a `url` only `https:` on `allowedFileOrigins`,
a `fileId` only one the root execution holds. `[files.answer-file-unseen]` at start for an answer with
file fields whose agent saw no file it could return. The three interim start refusals of PR 1 are gone.
