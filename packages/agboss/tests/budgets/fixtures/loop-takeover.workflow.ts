import { Text } from "../../../src/dto/index.js";
import {
  Agent,
  ApplicationContext,
  ChildPlacement,
  EmptyEnvironment,
  ExecutionContext,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ToolHandler,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { ItemDto, ItemResultDto } from "../../flow/runtime/fixtures/fan-out.workflow.js";

/**
 * #727 — a takeover in the middle of an agent's loop on a child on any instance: the loop's first
 * model call asks for a tool, the tool's first run holds (its worker freezes there), and the
 * instance that reclaims the child runs the tool again, then makes the loop's next two model calls
 * — new spend, each counted under its own ledger identity.
 */

export const loopTakeover = {
  /** The instance of each run of the hold tool, in order. */
  holds: [] as string[],
  /** The first run of the hold tool waits until this resolves (or its call is aborted). */
  held: Promise.resolve(),
};

export function resetLoopTakeover(): { readonly release: () => void } {
  loopTakeover.holds.length = 0;
  let release = (): void => undefined;
  loopTakeover.held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release };
}

export class HoldNoteDto {
  @Text({ prompt: "what to hold for" })
  name!: string;
}

@Tool({
  name: "loop-hold-tool",
  description: "Holds the first time it runs",
  input: HoldNoteDto,
  output: HoldNoteDto,
  deps: [ApplicationContext, ExecutionContext],
})
export class LoopHoldTool implements ToolHandler<HoldNoteDto, HoldNoteDto> {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly executionContext: ExecutionContext,
  ) {}

  async run(input: HoldNoteDto): Promise<HoldNoteDto> {
    loopTakeover.holds.push(this.applicationContext.instanceId);
    if (loopTakeover.holds.length === 1) {
      const { signal } = this.executionContext;
      await Promise.race([
        loopTakeover.held,
        new Promise((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        }),
      ]);
    }
    return input;
  }
}

@Agent({
  name: "loop-pay-agent",
  description: "Pays for its answer in several model calls",
  prompt: "Answer the item.",
  model: "moonshotai/kimi-k2.6",
  tools: [LoopHoldTool],
  input: { item: ItemDto },
  output: ItemResultDto,
  maxRetries: 0,
})
export class LoopPayAgent {}

@WorkflowStart({ name: "loop-pay-workflow-start", description: "One item", input: ItemDto })
export class LoopPayWorkflowStart {}

@WorkflowFinish({ name: "loop-paid-workflow-finish", description: "Done", output: ItemResultDto })
export class LoopPaidWorkflowFinish {}

@Workflow({
  name: "loop-pay-workflow",
  version: "1.0.0",
  flow: [
    start(LoopPayWorkflowStart)
      .returns(ItemDto)
      .toAgent(LoopPayAgent)
      .returns(ItemResultDto)
      .toFinish(LoopPaidWorkflowFinish),
  ],
})
export class LoopPayWorkflow {}

@WorkflowStart({ name: "loop-parent-workflow-start", description: "One item", input: ItemDto })
export class LoopParentWorkflowStart {}

@WorkflowFinish({ name: "loop-parent-workflow-finish", description: "Done", output: ItemResultDto })
export class LoopParentWorkflowFinish {}

@Workflow({
  name: "loop-parent-workflow",
  version: "1.0.0",
  flow: [
    start(LoopParentWorkflowStart)
      .returns(ItemDto)
      .toWorkflow(LoopPayWorkflow, { placement: ChildPlacement.AnyInstance })
      .returns(ItemResultDto)
      .toFinish(LoopParentWorkflowFinish),
  ],
})
export class LoopParentWorkflow {}

@Application({
  name: "loop-takeover-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LoopParentWorkflow],
  budgets: TEST_BUDGETS,
})
export class LoopTakeoverApplication {}
