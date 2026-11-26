/**
 * The compaction test applications (#120 PR 3): a help desk whose agents and router see one turn in full
 * and share one queue memory, which summarises what is older than that — behind a PII policy; a notes desk on one running summary; and a window desk
 * whose compaction writes no summaries, with an agent that sees every turn.
 */
import {
  Agent,
  CompactionStrategy,
  Memory,
  inline,
  Ttl,
  DecidedBy,
  TokenLimit,
  PiiKind,
  PiiPolicy,
  Router,
  TurnLimit,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart, toAgent, toFinish } from "../helpers/flow.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

const JEV = "typesafe/jev-1.13";

@PiiPolicy({
  name: "contact-pii-policy",
  description: "Hides email addresses from models",
  rules: [PiiKind.Email.tokenize()],
})
export class ContactPiiPolicy {}

/** A queue: every 2 turns older than its window become one summary, the latest 2 are kept. */
@Memory({
  name: "queue-memory",
  description: "Summarises the help desk's old turns",
  ttl: Ttl.Forever,
  uncompactedTurns: 1,
  turnsBetweenCompactions: 2,
  compaction: {
    strategy: CompactionStrategy.SummaryQueue,
    prompt: inline("Summarise the turns under `Turns to compact`."),
    model: "test/compactor",
    summaryQueueLength: 2,
    summaryMaxTokens: 200,
  },
})
export class QueueMemory {}

/** One running summary, rewritten every turn older than the window; the built-in prompt. */
@Memory({
  name: "note-memory",
  description: "Keeps one note of the notes desk",
  ttl: Ttl.Forever,
  uncompactedTurns: 1,
  turnsBetweenCompactions: 1,
  compaction: {
    strategy: CompactionStrategy.SingleSummary,
    model: "test/compactor",
    summaryMaxTokens: TokenLimit.ModelMax,
  },
})
export class NoteMemory {}

/** No summaries: only the window. */
@Memory({
  name: "window-only-memory",
  description: "Shows only the window of recent turns",
  ttl: Ttl.Forever,
  uncompactedTurns: 1,
})
export class WindowOnlyMemory {}

/** Every turn in full, no summaries. */
@Memory({
  name: "all-turns-memory",
  description: "Shows every turn of the thread",
  ttl: Ttl.Forever,
  uncompactedTurns: TurnLimit.All,
})
export class AllTurnsMemory {}

@WorkflowStart({
  name: "desk-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class DeskStart {}

@WorkflowFinish({
  name: "desk-answer-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class DeskAnswer {}

@WorkflowFinish({
  name: "desk-hand-over-workflow-finish",
  description: "A message handed over as it is",
  output: WorkflowStartTextDto,
})
export class DeskHandOver {}

/** Inherits its workflow's memory. */
@Agent({
  name: "answer-agent",
  description: "Answers",
  prompt: inline("Answer the message."),
  model: "test/answer",
})
export class AnswerAgent {}

/** Sees contacts in full: its model reads the summaries as they are stored, revealed. */
@Agent({
  name: "contact-agent",
  description: "Writes to the contacts it is given",
  prompt: inline("Write to the contact."),
  model: "test/contact",
  excludePiiPolicies: [ContactPiiPolicy],
})
export class ContactAgent {}

/** Its own window: one turn — the smallest among the queue compaction's readers. */
@Router({
  name: "help-router",
  description: "Sends the message on",
  decidedBy: DecidedBy.Model,
  prompt: inline("Pick who answers."),
  model: JEV,
  input: { message: WorkflowStartTextDto },
  routes: [
    { prompt: "Questions", target: AnswerAgent },
    { prompt: "Anything about a contact", target: ContactAgent },
  ],
})
export class HelpRouter {}

@Workflow({
  name: "help-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(DeskStart)
      .toRouter(HelpRouter)
      .onRoute(toAgent(AnswerAgent).toFinish(DeskAnswer))
      .onRoute(toAgent(ContactAgent).toFinish(DeskAnswer)),
  ],
  memory: QueueMemory,
})
export class HelpDeskWorkflow {}

@Application({
  name: "help-desk-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [HelpDeskWorkflow],
  piiPolicies: [ContactPiiPolicy],
  budgets: TEST_BUDGETS,
})
export class HelpDeskApplication {}

@Agent({
  name: "note-agent",
  description: "Answers from its note",
  prompt: inline("Answer the message."),
  model: "test/note",
})
export class NoteAgent {}

@Workflow({
  name: "notes-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(DeskStart).toAgent(NoteAgent).toFinish(DeskAnswer)],
  memory: NoteMemory,
})
export class NotesDeskWorkflow {}

@Application({
  name: "notes-desk-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [NotesDeskWorkflow],
  budgets: TEST_BUDGETS,
})
export class NotesDeskApplication {}

/** Every turn in full, whatever the workflow's window. */
@Agent({
  name: "archive-agent",
  description: "Answers from the whole thread",
  prompt: inline("Answer the message."),
  model: "test/archive",
  memory: AllTurnsMemory,
})
export class ArchiveAgent {}

@Router({
  name: "window-router",
  description: "Sends the message on",
  decidedBy: DecidedBy.Model,
  prompt: inline("Pick who answers."),
  model: JEV,
  input: { message: WorkflowStartTextDto },
  routes: [
    { prompt: "Questions", target: ArchiveAgent },
    { prompt: "Stop and hand the message over: anything else", target: DeskHandOver },
  ],
})
export class WindowRouter {}

@Workflow({
  name: "window-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(DeskStart)
      .toRouter(WindowRouter)
      .onRoute(toAgent(ArchiveAgent).toFinish(DeskAnswer))
      .onRoute(toFinish(DeskHandOver)),
  ],
  memory: WindowOnlyMemory,
})
export class WindowDeskWorkflow {}

@Application({
  name: "window-desk-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [WindowDeskWorkflow],
  budgets: TEST_BUDGETS,
})
export class WindowDeskApplication {}

/** Every turn older than a window of none: compacted before the next turn reads the thread. */
@Memory({
  name: "eager-memory",
  description: "Summarises every turn before the next one",
  ttl: Ttl.Forever,
  uncompactedTurns: 0,
  turnsBetweenCompactions: 1,
  compaction: {
    strategy: CompactionStrategy.SummaryQueue,
    model: "test/compactor",
    summaryQueueLength: 1,
    summaryMaxTokens: 100,
  },
})
export class EagerMemory {}

@Agent({
  name: "eager-agent",
  description: "Answers from the summary only",
  prompt: inline("Answer the message."),
  model: "test/eager",
})
export class EagerAgent {}

@Workflow({
  name: "eager-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(DeskStart).toAgent(EagerAgent).toFinish(DeskAnswer)],
  memory: EagerMemory,
})
export class EagerDeskWorkflow {}

@Application({
  name: "eager-desk-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [EagerDeskWorkflow],
  budgets: TEST_BUDGETS,
})
export class EagerDeskApplication {}
