import { Application } from "../../../src/application/application.js";
import {
  Budget,
  BudgetPeriod,
  BudgetScope,
  type BudgetHandler,
} from "../../../src/budgets/budget.js";
import { TerminalUserChannel } from "../../../src/channels/terminal-channel.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Agent,
  EmptyEnvironment,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ToolHandler,
} from "../../../src/index.js";
import { usd, type Usd } from "../../../src/units/index.js";
import { start } from "../../helpers/flow.js";
import { RecordingLogger } from "../../helpers/log.js";
import {
  SharedCheckpointSaver,
  SharedPausedExecutionRepository,
} from "../../helpers/shared-infrastructure.js";
import { RecordingCostLedgerRepository } from "./desks.application.js";

/**
 * #261 PR 6 — applications whose log the tests read (a `RecordingLogger` listed): the start log,
 * the assembly warnings (an in-memory ledger with tenant / application budgets, in-memory pauses
 * when a workflow can pause) and that no budget amount is read at start.
 */

/** How many times each budget's `maxSpend()` was called (the tests reset it). */
export const maxSpendCalls: string[] = [];

@Budget({
  name: "logged-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
export class LoggedApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    maxSpendCalls.push("application");
    return usd(100);
  }
}

@Budget({ name: "logged-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Month })
export class LoggedTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    maxSpendCalls.push("tenant");
    return usd(10);
  }
}

@Budget({ name: "logged-execution-budget", scope: BudgetScope.Execution })
export class LoggedExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    maxSpendCalls.push("execution");
    return usd(1);
  }
}

const budgets = [LoggedApplicationBudget, LoggedTenantBudget, LoggedExecutionBudget];

export class NoteDto {
  @Text({ prompt: "the note" })
  text!: string;
}

/** A tool with an approval channel: its workflow can pause. */
@Tool({
  name: "send-note-tool",
  description: "Sends a note",
  channel: TerminalUserChannel,
  input: NoteDto,
  output: NoteDto,
})
export class SendNote implements ToolHandler<NoteDto, NoteDto> {
  run(input: NoteDto): Promise<NoteDto> {
    return Promise.resolve(input);
  }
}

@Agent({
  name: "scribe-agent",
  description: "Writes notes",
  prompt: "Write.",
  model: "test/scribe",
})
export class ScribeAgent {}

@Agent({
  name: "sender-agent",
  description: "Sends notes",
  prompt: "Send.",
  model: "test/sender",
  tools: [SendNote],
})
export class SenderAgent {}

@WorkflowStart({ name: "note-workflow-start", description: "A note", input: WorkflowStartTextDto })
export class NoteWorkflowStart {}

@WorkflowStart({
  name: "send-workflow-start",
  description: "A note to send",
  input: WorkflowStartTextDto,
})
export class SendWorkflowStart {}

@WorkflowFinish({
  name: "note-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
export class NoteWorkflowFinish {}

@WorkflowFinish({
  name: "sent-workflow-finish",
  description: "Sent",
  output: WorkflowFinishTextDto,
})
export class SentWorkflowFinish {}

/** One agent, no pause. */
@Workflow({
  name: "note-workflow",
  version: "1.0.0",
  defaults: { models: { temperature: 0 } },
  uncompactedTurns: 1,
  flow: [
    start(NoteWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ScribeAgent)
      .toFinish(NoteWorkflowFinish),
  ],
})
export class NoteWorkflow {}

/** An agent whose tool waits for an approval: it can pause. */
@Workflow({
  name: "send-workflow",
  version: "1.0.0",
  defaults: { models: { temperature: 0 }, tools: { maxToolCalls: 2 } },
  uncompactedTurns: 1,
  flow: [
    start(SendWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(SenderAgent)
      .toFinish(SentWorkflowFinish),
  ],
})
export class SendWorkflow {}

/** Both workflows on the built-in in-memory infrastructure: both warnings. */
@Application({
  name: "logged-application",
  version: "2.3.0",
  environment: EmptyEnvironment,
  workflows: [NoteWorkflow, SendWorkflow],
  providers: [RecordingLogger],
  budgets,
})
export class LoggedApplication {}

/** The same on durable stores of its own: no warning. */
@Application({
  name: "durable-logged-application",
  version: "2.3.0",
  environment: EmptyEnvironment,
  workflows: [NoteWorkflow, SendWorkflow],
  providers: [
    RecordingLogger,
    RecordingCostLedgerRepository,
    SharedPausedExecutionRepository,
    SharedCheckpointSaver,
  ],
  budgets,
})
export class DurableLoggedApplication {}

/** No pause possible, in-memory ledger: only the ledger's warning. */
@Application({
  name: "note-logged-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [NoteWorkflow],
  providers: [RecordingLogger],
  budgets,
})
export class NoteLoggedApplication {}
