# Files for models — sources × views

An agent opts in to files for its model: it names the **sources** of the files (its input fields, its tools'
results, the thread's history) and the **views** its model gets of each file (the original, a redacted copy,
a transcription). The framework gives safe defaults and the developer decides — an agent without `files`
sends no byte to its model. Decision: [ADR-0036](ADR-0036-Files-reach-models-through-views).

```ts
import {
  Agent,
  AnswerFiles,
  FileSource,
  FileView,
  ModelFiles,
  inline,
} from "@agboss/core";
import { megabytes } from "@agboss/core/units";

@Agent({
  name: "invoice-reader-agent",
  description: "Reads an invoice and its items",
  prompt: inline("Read the invoice and its items."),
  model: "google/gemini-2.5-flash-lite",
  files: ModelFiles.of({
    sources: [FileSource.Input, FileSource.ToolResults, FileSource.History],
    views: [FileView.Original, FileView.Transcription],
    maxFileSize: megabytes(5),
    maxTotalFileSize: megabytes(10),
    maxFiles: 5,
    allowedMediaTypes: ["application/pdf", "image/png", "text/csv", "audio/mpeg", "video/mp4"],
    answerFiles: AnswerFiles.SeenInVisit,
    guardToolResultFiles: true,
  }),
})
export class InvoiceReaderAgent {}
```

## Sources

| Source | Files | Needs |
| --- | --- | --- |
| `FileSource.Input` (default) | the `FileDto` fields of the agent's input | nothing |
| `FileSource.ToolResults` | the `FileDto` fields of a tool's output; the tool message stays text, a user message with the parts follows | nothing |
| `FileSource.History` | the files of the turns the agent remembers: a turn keeps a descriptor, never bytes | an `FileRepository` that keeps files (`[files.history-needs-store]`) |

A history file is read through the guarded path as a copy under the execution that reads it: only a file of a
root execution of the same tenant and thread is read, never another thread's or tenant's. A file that
retention removed is shown as its descriptor, `(removed)`. The copy is an ordinary file of this execution, so
an agent can hand it back in its answer.

## Views

| View | What the model reads |
| --- | --- |
| `FileView.Original` | the file as a content part (an image, a PDF, audio, video) or as text (`text/*`, `application/json`) |
| `FileView.Redacted` | a copy with every PII kind the agent's policies name blacked out, made by a `FileRedactor` |
| `FileView.Transcription` | a text transcription by a `FileTranscriber`, masked by the policies' rules like any text |

The default view is `Original`, and `Transcription` where PII policies apply to the agent. Every file goes in
every view the agent has, each under its own heading: `### document (from start, file 1 of 2: invoice.pdf,
application/pdf, 84 KB, original)`. A text format is its own transcription (no model call), and masked where
policies apply, in any view.

## Limits fail closed

`maxFiles` (source files per model call), `maxFileSize`, `maxTotalFileSize` (all views of all files of one call)
and `allowedMediaTypes` are checked before any model call; a file over one is `StepError.ModelFileLimit`
(`step.model-file-limit`), never a silent truncation. The limits cascade: the agent's own, its workflow's and
application's `defaults.files`, then the workflow's `@FilePolicy` (#1316: the limits, the types, the origins, the fetch
timeout and pool), the built-ins. Every file passes the guarded path once per visit — allowed origins, no private address, no user
info, size, digest, magic bytes of its media type — and every model call of the visit carries the same bytes.

## Audio and video

`audio/mpeg|mp3 → mp3`, `audio/wav|x-wav → wav`, `audio/ogg`, `audio/flac`, `audio/aac`, `audio/mp4|m4a → m4a` go
as `input_audio`; `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska` as `video_url`. The same
rules as images: the media check (magic bytes), the limits, the start check of the model's input kinds.
Another audio format is `[model.unsupported-input]`.

## A model that cannot take a file

At start, where the provider reports the kinds it takes (`ModelCapabilities.inputs`), every kind an agent's
files can produce must be in them — its model, its fallbacks, its input guardrails and judges, the built-in
transcriber's and redactor's models — else `[model.unsupported-input]`; a defaulted `allowedMediaTypes` is
narrowed to what the models take. Where the provider cannot say, the call fails with `ModelCallError`
`model.unsupported-input`, which is never retried and never falls back.

## PII on files

`@PiiPolicy({ files: PiiFileAction.Mask | PiiFileAction.AllowOriginal })`, default `Mask`:

- a transcription is masked by the rules where it is made, a block rule refusing before anything is kept;
- a redacted copy has every kind the rules name blacked out; any failure is `StepError.FileMaskingFailed` — never
  the unredacted file;
- **a block rule refuses an image whole by default.** Which kinds an image holds is a model's judgement, and a
  text in the image can talk a model into silence ("no personal data here"). So where a policy has a block rule,
  an image in the redacted view is refused (`PiiError.Refused`, the policy's text) before any model is asked.
  `PiiFileAction.RedactWithModel` on the policy is the explicit opt-in to let the redaction model decide: a kind
  a block rule names that it finds refuses the file, an empty, malformed or truncated answer fails closed — and
  a model that obeys the text in the image lets it through. **Model-checked images are a guardrail, not a
  guarantee**: choose a deterministic redactor of your own, or `Transcription` (masked by formats, which no text
  in an image can talk down), where a leak is a payment-grade matter;
- the original goes to the model only where every applying policy says `AllowOriginal`
  (`[pii.original-file]` otherwise); `Redacted` under a project's own detector is
  `[pii.redacted-needs-kinds]`.

PII never reads bytes: a file part is passed through the mask untouched.

The execution's exact sensitive values (`sensitive` context fields) go to the redaction model with the kinds only
where it is the same provider as the agent's own model (`defaults.files.redactionValues:
RedactionValues.SameProvider`, the default). "The same" is decided fail-closed: the same provider, or one on the
same base URL with the same key field — never by a name; not when the two models are of different vendors behind
one aggregator (the default OpenRouter serves `anthropic/…` and `google/…` alike), and not when the redaction
provider's circuit breaker can fail over to another provider. In doubt it is not the same. `Never` sends the kinds only,
`Always` is an explicit decision to send them wherever the redactor runs. A project's own redactor gets the
values only on `Always`. Values that cannot be sent never leave a gap: where the contexts hold `sensitive` fields
and the redactor may not be told them the application does not start (`[files.redactor-values-withheld]`, naming
both providers and the opt-in), and at run time a redaction with values it may not send, or with nothing at all
to look for, fails closed (`StepError.FileMaskingFailed`) — an unchanged re-encode is never passed off as redacted.
A redacted copy is cached for the policies and the exact value set it was made for (one HMAC of both under the
file-cache key, [Guards → the PII key hierarchy](Guards#the-pii-key-hierarchy), and a "kinds only" marker when no
value is sent), in the state of one execution; a masked transcription by its policies' keyed hash.

## The redactor and the transcriber

Both are contracts, one per application, listed in `@Application({ providers })`; the built-ins run on a cheap
vision model (`defaults.files.transcriptionModel`, `redactionModel`, default `google/gemini-2.5-flash-lite`).

```ts
import { FileRedactor, Injectable, type RedactionResult } from "@agboss/core";

@Injectable()
export class PresidioImageRedactor extends FileRedactor {
  supports(mediaType: string): boolean {
    return mediaType === "image/png"; // asked at start, on the class: answer from the media type alone
  }

  redact(): Promise<RedactionResult> {
    return Promise.reject(new Error("call your service here"));
  }
}
```

`ModelImageRedactor` redacts png, jpeg and webp: the image is turned upright (its EXIF orientation applied),
the model names the regions, a copy without metadata has them painted black, padded 10 %. A multi-frame
image, an image over 40 megapixels (its header says so: nothing is decoded), a model answer that is not strictly valid or names more than 200 regions, any failure — fail closed. All the regions are painted in one buffer: memory is one full-size image, however many regions there are (#1257).
`sharp` is an **optional peer dependency** (`npm i sharp`); the built-in without it is a start error. A type no
redactor `supports` is `[files.no-redactor]`. A redacted copy is kept in the file store when one is listed,
else inline in the execution's state up to 64 KB (`[files.redacted-needs-store]` for limits that allow more).
Spend is billed under `files:transcriber` / `files:redactor` (`CostCategory.Files`), the budget checked
before each call, and a copy is made once per execution for its file, redactor and policies.

## Guardrails, judges and answers

Input guardrails and model judges see what the agent's model sees, files included; output guardrails see the
files of the answer ([Guards](Guards)). `AnswerFiles.SeenInVisit` (default): an answer's file is `{ file: <n>
}`, the number in the headings, mapped to the view the model saw; `AnswerFiles.Any`: the model's descriptors,
a url only `https:` on the policy's `allowedOrigins`, a `fileId` only one this execution owns. Only an original can be
returned by number: an agent that reads files only as `Redacted` or `Transcription` and answers with files is
`[files.answer-file-unseen]`, and `AnswerFiles.Any` on an agent whose files a policy masks (without
`FileView.Original`) is `[pii.original-file]` — the model could hand back the unmasked input.

## Seeing it

`agboss describe` prints each agent's files (`input → original (5 files, 5 MB each, 10 MB in all) · answer
files: seen-in-visit`) and `describe --json` carries `AgentSnapshot.files`. The config hash covers the files
settings, each policy's file action and the application's own `FileRedactor` and `FileTranscriber` by class name
(#1269: another one is another configuration — a paused run is not resumed blindly under it). A request shows a file as `{ kind, mediaType, sizeBytes, sha256 }` in
events, traces, records and cassettes — never its bytes ([Observability](Observability)); tests script
`mockModel(FileTranscriber)` and `mockModel(FileRedactor)` ([Testing](Testing)). The examples are `invoice-workflow`,
`kyc-workflow` and `audio-note-workflow` of `examples/flow-patterns`.
