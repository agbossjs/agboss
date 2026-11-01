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
| `listOf(XDto)` / `listOf(oneOf(…))` | input, output, a start's input, `.returns(…)` | a list; a `listOf(oneOf(…))` is one polymorphic list — it never fills a `listOf(XDto)` field |
| `oneOf(ADto, BDto, …)` | output of agents and actions | one of the classes; `.returns(oneOf(…)).switch(caseOf(…))` branches by it |
| `optional(XDto)` / `optional(listOf(XDto))` | input only | may be absent |
| `historyOf(XDto, { limit })` | input only | `HistoryOf<Produced<XDto, P>>`: `{ current, previous }`, the earlier versions oldest first (at most `limit`) |
| `variant(XDto, value)` | an action's result | names the class of a `oneOf` it returns — never guessed by shape |
| `isVariant(value, XDto)` | code | narrows a `oneOf` value — also a judge's input or a `VariantOf` item, by its `variant` class (#262 S125) |
| `VariantOf<A \| B>` | a `listOf(oneOf(…))` judge's `reply` items | `{ variant, value }`: the class an item validated as (from its answer tool) and its value |

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
| `AttachmentDto` | `name`, `mediaType` (`application/pdf`), `url?`, `content?` (base64)           | exactly one of `url` and `content`          |
| `AddressDto`    | `street`, `city`, `region?`, `postalCode?`, `country` (ISO 3166-1: `IL`)       | —                                           |
| `PersonNameDto` | `given`, `family?`                                                             | —                                           |
| `ContactInfoDto` | `email?`, `phone?` (E.164: `+972521234567`)                                    | at least one of `email` and `phone`         |
| `RagSourceReferenceDto` | `title`, `url?`, `quote?` (≤ 300 characters) — where a statement in an answer comes from, in a knowledge base | — |

- Money is a **decimal string**, never a float: exact, and readable by people and the model; do
  arithmetic with a decimal library.
- A cross-field violation is the same validation error as any other, with the field and the reason
  (`to: the last day is before the first`).
