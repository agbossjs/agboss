/**
 * The compaction test applications (#120 PR 3): a help desk whose router sees one turn in full and
 * whose answer agent sees three — one queue compaction for both, so it summarises what is older
 * than one turn — behind a PII policy; a notes desk on one running summary; and a window desk
 * whose compaction writes no summaries, with an agent that sees every turn.
 */
import {
  Agent,
  Compaction,
  CompactionStrategy,
  DecidedBy,
  TokenLimit,
  PiiAction,
  PiiKind,
  PiiPolicy,
  Router,
  TurnLimit,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  pii,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { route, start } from "../helpers/flow.js";

const JEV = "typesafe/jev-1.13";

@PiiPolicy({
  name: "contact-pii-policy",
  description: "Hides email addresses from models",
  rules: [pii(PiiKind.Email, PiiAction.replaceWithToken())],
})
export class ContactPiiPolicy {}

/** A queue: every 2 turns older than its window become one summary, the latest 2 are kept. */
@Compaction({
  name: "queue-compaction",
  description: "Summarises the help desk's old turns",
  prompt: "Summarise the turns under `Turns to compact`.",
  model: "test/compactor",
  strategy: CompactionStrategy.SummaryQueue,
  turnsBetweenCompactions: 2,
  summaryQueueLength: 2,
  summaryMaxTokens: 200,
})
export class QueueCompaction {}

/** One running summary, rewritten every turn older than the window; the built-in prompt. */
@Compaction({
  name: "note-compaction",
  description: "Keeps one note of the notes desk",
  model: "test/compactor",
  strategy: CompactionStrategy.SingleSummary,
  turnsBetweenCompactions: 1,
  summaryMaxTokens: TokenLimit.MODEL_MAX,
})
export class NoteCompaction {}

/** No summaries: only the window. */
@Compaction({
  name: "no-summaries-compaction",
  description: "Shows only the window of recent turns",
  strategy: CompactionStrategy.None,
})
export class NoSummariesCompaction {}

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

/** Inherits the application's window (3) and compaction. */
@Agent({
  name: "answer-agent",
  description: "Answers",
  prompt: "Answer the message.",
  model: "test/answer",
})
export class AnswerAgent {}

/** Sees contacts in full: its model reads the summaries as they are stored, revealed. */
@Agent({
  name: "contact-agent",
  description: "Writes to the contacts it is given",
  prompt: "Write to the contact.",
  model: "test/contact",
  excludePiiPolicies: [ContactPiiPolicy],
  uncompactedTurns: 1,
})
export class ContactAgent {}

/** Its own window: one turn — the smallest among the queue compaction's readers. */
@Router({
  name: "help-router",
  description: "Sends the message on",
  decidedBy: DecidedBy.Model,
  prompt: "Pick who answers.",
  model: JEV,
  input: { message: WorkflowStartTextDto },
  uncompactedTurns: 1,
  routes: [
    { prompt: "Questions", target: AnswerAgent },
    { prompt: "Anything about a contact", target: ContactAgent },
  ],
})
export class HelpRouter {}

@Workflow({
  name: "help-desk-workflow",
  version: "1.0.0",
  flow: [
    start(DeskStart)
      .returns(WorkflowStartTextDto)
      .toRouter(HelpRouter)
      .chooseOne(route(AnswerAgent).toFinish(DeskAnswer), route(ContactAgent).toFinish(DeskAnswer)),
  ],
})
export class HelpDeskWorkflow {}

@Application({
  name: "help-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [HelpDeskWorkflow],
  piiPolicies: [ContactPiiPolicy],
  compaction: QueueCompaction,
  uncompactedTurns: 3,
  budgets: TEST_BUDGETS,
})
export class HelpDeskApplication {}

@Agent({
  name: "note-agent",
  description: "Answers from its note",
  prompt: "Answer the message.",
  model: "test/note",
})
export class NoteAgent {}

@Workflow({
  name: "notes-desk-workflow",
  version: "1.0.0",
  flow: [start(DeskStart).returns(WorkflowStartTextDto).toAgent(NoteAgent).toFinish(DeskAnswer)],
  compaction: NoteCompaction,
  uncompactedTurns: 1,
})
export class NotesDeskWorkflow {}

@Application({
  name: "notes-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [NotesDeskWorkflow],
  budgets: TEST_BUDGETS,
})
export class NotesDeskApplication {}

/** Every turn in full, whatever the workflow's window. */
@Agent({
  name: "archive-agent",
  description: "Answers from the whole thread",
  prompt: "Answer the message.",
  model: "test/archive",
  uncompactedTurns: TurnLimit.ALL,
})
export class ArchiveAgent {}

@Router({
  name: "window-router",
  description: "Sends the message on",
  decidedBy: DecidedBy.Model,
  prompt: "Pick who answers.",
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
  flow: [
    start(DeskStart)
      .returns(WorkflowStartTextDto)
      .toRouter(WindowRouter)
      .chooseOne(route(ArchiveAgent).toFinish(DeskAnswer), route(DeskHandOver)),
  ],
  compaction: NoSummariesCompaction,
  uncompactedTurns: 1,
})
export class WindowDeskWorkflow {}

@Application({
  name: "window-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [WindowDeskWorkflow],
  budgets: TEST_BUDGETS,
})
export class WindowDeskApplication {}

/** Every turn older than a window of none: compacted before the next turn reads the thread. */
@Compaction({
  name: "eager-compaction",
  description: "Summarises every turn before the next one",
  model: "test/compactor",
  strategy: CompactionStrategy.SummaryQueue,
  turnsBetweenCompactions: 1,
  summaryQueueLength: 1,
  summaryMaxTokens: 100,
})
export class EagerCompaction {}

@Agent({
  name: "eager-agent",
  description: "Answers from the summary only",
  prompt: "Answer the message.",
  model: "test/eager",
})
export class EagerAgent {}

@Workflow({
  name: "eager-desk-workflow",
  version: "1.0.0",
  flow: [start(DeskStart).returns(WorkflowStartTextDto).toAgent(EagerAgent).toFinish(DeskAnswer)],
  compaction: EagerCompaction,
  uncompactedTurns: 0,
})
export class EagerDeskWorkflow {}

@Application({
  name: "eager-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [EagerDeskWorkflow],
  budgets: TEST_BUDGETS,
})
export class EagerDeskApplication {}
