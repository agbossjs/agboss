// #860 AC3 — workflows a direct-reply skill may not run (each breaks one rule of
// `[a2a.message-skill-*]`), and an application that exposes one start of them as `A2AReply.Message`
// on given stores.
import { A2AExpose, A2AReply } from "../../../src/a2a/a2a-expose.decorator.js";
import { OutboundCalls } from "../../../src/app/outbound-calls.js";
import { Application } from "../../../src/application/application.js";
import { Injectable, Tool, type ToolHandler } from "../../../src/components/decorators.js";
import type { Class, Provider } from "../../../src/components/injection.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { Produced } from "../../../src/index.js";
import { FencedEffectRepository } from "../../../src/infrastructure/fenced-effect.repository.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { SqliteTestEnvironment } from "../../infrastructure/sqlite/fixtures/environments/app.environment.js";
import { BoardLookupTool, PingTool } from "../../tool-interceptors/components.fixture.js";
import { TckCallerChannel, TckWorkflow, TckWorkflowStart } from "../../a2a-tck/tck.application.js";
import { PriceLookupTool, QuoteWorkflow } from "./direct.application.js";

type Message = { readonly message: Produced<WorkflowStartTextDto, unknown> };

/** A service two hops from the effect store: what a tool injects. */
@Injectable({ deps: [FencedEffectRepository] })
export class LedgerWriter {
  constructor(readonly effects: FencedEffectRepository<unknown>) {}
}

@Injectable({ deps: [LedgerWriter] })
export class LedgerService {
  constructor(readonly writer: LedgerWriter) {}
}

/** A tool that reads only by its flag, yet writes through its service. */
@Tool({
  name: "ledger-read-tool",
  description: "Reads the ledger",
  input: WorkflowStartTextDto,
  output: WorkflowFinishTextDto,
  readOnly: true,
  deps: [LedgerService],
})
export class LedgerReadTool implements ToolHandler<WorkflowStartTextDto, WorkflowFinishTextDto> {
  constructor(readonly ledger: LedgerService) {}

  run(): Promise<WorkflowFinishTextDto> {
    return Promise.resolve({ text: "done" });
  }
}

@Agent({
  name: "busy-agent",
  description: "Calls every kind of tool",
  prompt: "Answer.",
  model: "moonshotai/kimi-k2.6",
  tools: [PriceLookupTool, PingTool, BoardLookupTool, LedgerReadTool],
})
export class BusyAgent {}

@Action({
  name: "charge-action",
  description: "Charges through OutboundCalls",
  input: { message: WorkflowStartTextDto },
  deps: [OutboundCalls],
})
export class ChargeAction {
  constructor(readonly calls: OutboundCalls) {}

  execute(_input: Message): Promise<void> {
    return Promise.resolve();
  }
}

@Action({ name: "refund-action", description: "Refunds", input: { message: WorkflowStartTextDto } })
export class RefundAction {
  execute(_input: Message): Promise<void> {
    return Promise.resolve();
  }
}

@Action({
  name: "reserve-action",
  description: "Reserves, undone by a refund",
  input: { message: WorkflowStartTextDto },
  compensateWith: RefundAction,
})
export class ReserveAction {
  execute(_input: Message): Promise<void> {
    return Promise.resolve();
  }
}

@WorkflowStart({ name: "busy-workflow-start", description: "Busy", input: WorkflowStartTextDto })
export class BusyWorkflowStart {}

@WorkflowFinish({
  name: "busy-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
export class BusyWorkflowFinish {}

@Workflow({
  name: "busy-workflow",
  version: "1.0.0",
  flow: [
    start(BusyWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(ChargeAction)
      .toAction(ReserveAction)
      .toWorkflow(QuoteWorkflow)
      .returns(WorkflowFinishTextDto)
      .toFinish(BusyWorkflowFinish),
    start(BusyAgentWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(BusyAgent)
      .toFinish(BusyWorkflowFinish),
  ],
})
export class BusyWorkflow {}

/** The starts of the fixture and their workflows. */
export const STARTS: ReadonlyMap<Class, Class> = new Map<Class, Class>([
  [BusyWorkflowStart, BusyWorkflow],
  [TckWorkflowStart, TckWorkflow],
]);

/** An application exposing `start` with `reply`, its workflow and `providers` listed. */
export function directRulesApplication(
  exported: Class,
  providers: readonly Provider[] = [],
  skills: Readonly<Record<string, { readonly reply: A2AReply }>> = {},
  defaultSkill?: Class,
): Class {
  const name = exported === BusyWorkflowStart ? "busy-workflow-start" : "tck-workflow-start";
  @A2AExpose({
    name: "rules-a2a-expose",
    version: "1.0.0",
    description: "Direct replies",
    exports: [exported],
    skills: { [name]: { reply: A2AReply.Message }, ...skills },
    ...(defaultSkill === undefined ? {} : { defaultSkill }),
  })
  class RulesA2AExpose {}
  const workflow = STARTS.get(exported);
  @Application({
    name: "rules-application",
    version: "1.0.0",
    environment: SqliteTestEnvironment,
    workflows: workflow === undefined ? [] : [workflow, QuoteWorkflow],
    budgets: TEST_BUDGETS,
    providers: [...providers, ...(exported === TckWorkflowStart ? [TckCallerChannel] : [])],
    exposes: [RulesA2AExpose],
  })
  class RulesApplication {}
  return RulesApplication;
}
