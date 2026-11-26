# Standard DTOs

Ready-made DTOs in `@agboss/core/dto` — use them instead of writing the same shape again. They are
plain classes like your own ([Components → DTOs](Components#dtos)); every field has a `prompt`.
Like every DTO that may stand on a path, their names end with `Dto` (#270, `[dto.name]`).

```ts
import { MoneyDto, NoInputDto, PlainTextDto } from "@agboss/core/dto";
```

## Wrappers

On paths and in `input` / `output` a DTO is wrapped by what it means (`@agboss/core/dto`,
[Path scope](Path-scope)):

| Wrapper | Where | |
| --- | --- | --- |
| `listOf(XDto)` / `listOf(ADto, BDto, …)` | input, output, a start's input | a list; `listOf(ADto, BDto)` is one polymorphic list, each item one of the classes |
| `oneOf(ADto, BDto, …)` | output of agents and actions | one of the classes; `.toOneOf([…])` continues with one branch per class; an action returns an instance of the class, which the framework recognises by its prototype |
| `optional(XDto)` / `optional(listOf(XDto))` | input only | may be absent |
| `historyOf(XDto, { maxPrevious })` | input only | `HistoryOf<Tracked<XDto, P>>`: `{ current, previous }`, the earlier versions oldest first (at most `maxPrevious`) |

## Names: the hierarchy rule (#141)

- **A DTO that belongs to a component kind starts with that kind** and ends with `Dto`:
  `WorkflowStart…Dto`, `WorkflowFinish…Dto`, `WorkflowPause…Dto`, `ToolCallApproval…Dto`, `Rag…Dto`.
- **Paired concepts get paired names**: start / finish, question / answer, ask / decision.
- **Nothing "chat", "user", "human" or "person"** in framework names, prompts or comments: a workflow
  may be a CI pipeline, a pause or an approval may be answered by a system.

## For the framework's own parts

| DTO                        | Fields                                                     | Used for                                                          |
| --------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `WorkflowStartTextDto`     | `text` (non-empty), `author?` (`sensitive: replaceWithToken()`)                  | the text a run starts with — input of a text `@WorkflowStart`     |
| `WorkflowFinishTextDto`    | `text`                                                     | the text a run finishes with — output of a text `@WorkflowFinish` |
| `WorkflowPauseQuestionDto` | `question`, `options?` (≤ 6)                               | what a workflow pause asks outside the run — a person or a system |
| `WorkflowPauseAnswerDto`   | `replyWith`                                                   | the answer to that question                                       |
| `ToolCallApprovalAskDto`   | `callId`, `tool`, `arguments` (any JSON object), `summary` | a tool call waiting for approval — one call per pause             |
| `ToolCallApprovalDecisionDto` | `approved`, `by` (who or what decided), `feedback?`, `overrideArguments?` | the decision on that call — what `app.resume` takes ([Pause seam](Pause-seam)) |
| `ReplyInterpreterNotUnderstoodDto` | `reason` | what a model reply interpreter answers for a reply that does not answer its pause (#648) — never a refusal ([Pauses](Pauses)) |
| `WorkflowFinishFileDto`    | `file` (`FileDto`)                                         | the file a run finishes with — output of a file `@WorkflowFinish` |
| `WorkflowFinishFilesDto`   | `files` (`FileDto[]`, at least one)                        | the files a run finishes with, one part per file, in order        |
| `NoInputDto`               | —                                                          | the input of a tool that takes nothing (`{}`)                     |
| `PlainTextDto`             | `text`                                                     | plain text, e.g. a text-only MCP server tool's result             |
| `RagSearchResultDto`       | `text`, `source`, `score?` (0…1)                           | a piece of text a knowledge base (`@Rag`) found for a query       |

`WorkflowPauseQuestionDto` / `WorkflowPauseAnswerDto` are for workflow questions, which nothing
asks yet (#659; tools no longer pause themselves — [Pause seam](Pause-seam)).

Renamed in #270 (old names removed, not aliased): every standard DTO got the `Dto` suffix
(`WorkflowStartText` → `WorkflowStartTextDto`, `Money` → `MoneyDto`, …). Renamed before, in #141: `ChatMessage` → `WorkflowStartText`, `TextAnswer`
→ `WorkflowFinishText` (or `PlainText` for a server tool), `Question` → `WorkflowPauseQuestion`,
`Clarification` → `WorkflowPauseAnswer`, `ApprovalRequest` → `ToolCallApprovalAsk`,
`ApprovalDecision` → `ToolCallApprovalDecision`, `Passage` → `RagSearchResult`, `Citation` →
`RagSourceReference`.

## Common domain shapes

| DTO             | Fields                                                                         | Checked across fields                       |
| ---------------- | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| `MoneyDto`      | `amount` (`DecimalString`, 2 digits: `"19.99"`), `currency` (ISO 4217: `USD`) | —                                           |
| `DateRangeDto`  | `from`, `to` (`Date`: `2026-09-01`), `timeZone?` (IANA)                        | `from` ≤ `to` — days, both ends included    |
| `DateTimeRangeDto` | `from`, `to` (`DateTime` with an offset)                                       | `from` < `to` — moments, offsets respected  |
| `FileDto`       | `mediaType` (`application/pdf`), `filename?`, and exactly one source: `fileId` (the application's file store), `inline` (base64, with `sha256` and `sizeBytes`) or `url` (http(s)) | exactly one of `fileId`, `inline` and `url` |
| `AddressDto`    | `street`, `city`, `region?`, `postalCode?`, `country` (ISO 3166-1: `IL`)       | —                                           |
| `PersonNameDto` | `given`, `family?`                                                             | —                                           |
| `ContactInfoDto` | `email?`, `phone?` (E.164: `+972521234567`)                                    | at least one of `email` and `phone`         |
| `RagSourceReferenceDto` | `title`, `url?`, `quote?` (≤ 300 characters) — where a statement in an answer comes from, in a knowledge base | — |

- A field that holds a file is `@File()` (`@File({ optional: true })`; a list is `@List(FileDto, …)`), imported with `FileDto` from `@agboss/core/dto`. `FileDto.fromBytes(bytes, { mediaType })` and `FileDto.fromUrl(url, { mediaType })` build one; where it is shown (a prompt, a record, a trace) only its media type, name and size are ([Files for models](Files-for-models)).
- Money is a **decimal string**, never a float: exact, and readable by people and the model; do
  arithmetic with a decimal library.
- A cross-field violation is the same validation error as any other, with the field and the reason
  (`to: the last day is before the first`).
