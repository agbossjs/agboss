# ADR-0036: Files reach models through sources and views

Status: accepted (#899). Builds on #859 (A2A files) and #120 (PII policies and guardrails).

## Context

An agent that takes documents over A2A has to see them in its model. Until #899 a model never saw a file's
bytes, and the base64 `inline` of an `A2AFileDto` was rendered into prompts, tool results and records as text.
Who sees a file, from where, in which form, and what privacy rules do to it each differ per application.

## Decision

1. **Bytes are never text.** Every boundary renderer shows `{ mediaType, filename?, sizeBytes, sha256, source }`
   (`redactedFileOf`), always on. A model message carries a file as a part; one place (`toWireRequest`) writes it
   for the wire.
2. **An agent opts in, field by field.** `files: ModelFiles.of({ sources, views, limits, … })` over
   `defaults.files` over the skills' limits. Without it, no byte reaches the model.
3. **Sources × views are the model's contract.** Sources: input, tool results, history. Views: original,
   redacted, transcription — any set, every file in every view, one heading each.
4. **A policy decides what is allowed.** A transcription is masked by the rules like any text; a redacted copy
   has every kind the rules name blacked out; the original goes to the model only where every applying policy
   says `AllowOriginal`, else the application does not start. PII never reads bytes.
5. **Redaction is a contract.** `FileRedactor` and `FileTranscriber` have built-ins on a cheap vision model and
   a project's own; a built-in that cannot do its job (no `sharp`, a type it does not take) is a start error.
   Anything that goes wrong in a redaction fails closed: the unredacted file never goes to the model in its
   place, and what a model wrote never enters an error message, a log or a cause.
   A block rule refuses an image whole unless the policy says `PiiFileAction.RedactWithModel`: a model's
   judgement of an image is a guardrail, not a guarantee. The exact PII values go to a redaction model only on
   the agent's own provider, or on `RedactionValues.Always`.
6. **The guards see what the model sees.** Input guardrails, judges and output guardrails read the same files in
   the same views, masked as the agent's model reads them.
7. **One guarded read, pinned.** A visit reads each file once through the #859 / #904 guarded path and every
   model call, guardrail and judge gets the same bytes and `sha256`; a file that changed is refused.
8. **The developer decides the rest.** Answer files (`SeenInVisit` by default, `Any` explicit), tool-result file
   guards, limits and media types are settings with the safe default.

## Consequences

- `CostReport.byCategory` has a `files` key; stored records written before it read it as 0.
- The root import stays light: the redactor, the transcriber's work, the history reader, the guarded views and
  the answer's guard load on first use; `sharp` is an optional peer dependency.
- `FileSource.History` needs a file store: a turn keeps a descriptor, not bytes, and a history file is copied
  under the execution that reads it.
- A redacted view of a type no redactor takes is a start error, not a runtime surprise.
