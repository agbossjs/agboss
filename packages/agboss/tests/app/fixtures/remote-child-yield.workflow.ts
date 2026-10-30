import { Text } from "../../../src/dto/index.js";
import {
  Action,
  Agent,
  Channel,
  ChannelOutcome,
  ChildPlacement,
  EmptyEnvironment,
  ExecutionContext,
  Injectable,
  listOf,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ChannelAsk,
  type ExecutionEndEvent,
  type ExecutionStartEvent,
  type OnExecutionEnd,
  type OnExecutionStart,
  type Produced,
  type ToolHandler,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { RecordingLogger } from "../../helpers/log.js";
import {
  ItemDto,
  ItemResultDto,
  SummaryWorkflowFinish,
} from "../../flow/runtime/fixtures/fan-out.workflow.js";

/**
 * #516 — a parent waiting for its `ChildPlacement.AnyInstance` children while another instance's
 * recovery sweep looks for `running` roots. A child's gated step holds every item named `gate…`
 * until the test opens the gate; a review child asks for a confirmation of every item named
 * `ask…` through a channel that records the pause's id. What ran where, and every execution's
 * start and end, are kept for the test.
 */

/** One run of the gated step: the item and the instance it ran on. */
export interface GatedRun {
  readonly name: string;
  readonly instanceId: string;
}

/** What the components and the observer saw, in order (reset with `resetYield`). */
export const yieldSeen = {
  runs: [] as GatedRun[],
  pauseIds: [] as string[],
  starts: [] as string[],
  ends: [] as string[],
};

/** The gate the `gate…` items wait at, opened by the test. */
const gate = { opened: Promise.resolve(), open: (): void => undefined };

export function closeGate(): void {
  gate.opened = new Promise((resolve) => {
    gate.open = resolve;
  });
}

export function openGate(): void {
  gate.open();
}

export function resetYield(): void {
  yieldSeen.runs.length = 0;
  yieldSeen.pauseIds.length = 0;
  yieldSeen.starts.length = 0;
  yieldSeen.ends.length = 0;
  closeGate();
}

/** Rejects when `signal` aborts: the step stops (its signal's reason as the cause). */
const abortOf = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(new Error("stopped", { cause: signal.reason }));
      },
      { once: true },
    );
  });

/** Records the run of `name` on the step's instance; a `gate…` item waits at the gate. */
async function passGate(executionContext: ExecutionContext, name: string): Promise<void> {
  const { instanceId } = executionContext.tenant.application;
  yieldSeen.runs.push({ name, instanceId });
  if (name.startsWith("gate")) await Promise.race([gate.opened, abortOf(executionContext.signal)]);
}

@Action({
  name: "gated-item-action",
  description: "Processes one item; a gate item waits until the test opens the gate",
  input: { item: ItemDto },
  output: ItemResultDto,
  deps: [ExecutionContext],
})
export class GatedItemAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  async execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<ItemResultDto> {
    const { name } = input.item.value;
    await passGate(this.executionContext, name);
    return { name };
  }
}

@Action({
  name: "gated-result-action",
  description: "Passes a reviewed item on; a gate item waits until the test opens the gate",
  input: { result: ItemResultDto },
  output: ItemResultDto,
  deps: [ExecutionContext],
})
export class GatedResultAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  async execute(input: {
    readonly result: Produced<ItemResultDto, unknown>;
  }): Promise<ItemResultDto> {
    const { name } = input.result.value;
    await passGate(this.executionContext, name);
    return { name };
  }
}

/** A channel the confirmation names as is: records the pause's id and waits for the answer. */
@Channel({ name: "recording-channel" })
export class RecordingChannel {
  send(ask: ChannelAsk<RecordingChannel>): Promise<ChannelOutcome<RecordingChannel>> {
    yieldSeen.pauseIds.push(ask.pauseId);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

export class ItemConfirmDto {
  @Text({ prompt: "the item to confirm" })
  name!: string;
}

@Tool({
  name: "confirm-item-tool",
  description: "Confirms an item",
  channel: RecordingChannel,
  input: ItemConfirmDto,
  output: ItemConfirmDto,
})
export class ConfirmItemTool implements ToolHandler<ItemConfirmDto, ItemConfirmDto> {
  run(input: ItemConfirmDto): Promise<ItemConfirmDto> {
    return Promise.resolve(input);
  }
}

@Agent({
  name: "yield-reviewer-agent",
  description: "Reviews one item, confirming it first when asked to",
  prompt: "Review the item.",
  model: "moonshotai/kimi-k2.6",
  tools: [ConfirmItemTool],
  input: { item: ItemDto },
  output: ItemResultDto,
})
export class YieldReviewerAgent {}

@WorkflowStart({
  name: "yield-check-workflow-start",
  description: "One item checked by a child on any instance",
  input: ItemDto,
})
export class YieldCheckWorkflowStart {}

@WorkflowFinish({
  name: "yield-checked-workflow-finish",
  description: "The item, checked",
  output: ItemResultDto,
})
export class YieldCheckedWorkflowFinish {}

@Workflow({
  name: "yield-check-workflow",
  version: "1.0.0",
  flow: [
    start(YieldCheckWorkflowStart)
      .returns(ItemDto)
      .toAction(GatedItemAction)
      .returns(ItemResultDto)
      .toFinish(YieldCheckedWorkflowFinish),
  ],
})
export class YieldCheckWorkflow {}

@WorkflowStart({
  name: "yield-review-workflow-start",
  description: "One item reviewed by a child on any instance",
  input: ItemDto,
})
export class YieldReviewWorkflowStart {}

@WorkflowFinish({
  name: "yield-reviewed-workflow-finish",
  description: "The item, reviewed",
  output: ItemResultDto,
})
export class YieldReviewedWorkflowFinish {}

@Workflow({
  name: "yield-review-workflow",
  version: "1.0.0",
  flow: [
    start(YieldReviewWorkflowStart)
      .returns(ItemDto)
      .toAgent(YieldReviewerAgent)
      .returns(ItemResultDto)
      .toAction(GatedResultAction)
      .returns(ItemResultDto)
      .toFinish(YieldReviewedWorkflowFinish),
  ],
})
export class YieldReviewWorkflow {}

@WorkflowStart({
  name: "yield-one-workflow-start",
  description: "One item, checked by one child on any instance",
  input: ItemDto,
})
export class YieldOneWorkflowStart {}

@WorkflowFinish({
  name: "yield-one-workflow-finish",
  description: "The item the child checked",
  output: ItemResultDto,
})
export class YieldOneWorkflowFinish {}

@Workflow({
  name: "yield-one-workflow",
  version: "1.0.0",
  flow: [
    start(YieldOneWorkflowStart)
      .returns(ItemDto)
      .toWorkflow(YieldCheckWorkflow, { placement: ChildPlacement.AnyInstance })
      .returns(ItemResultDto)
      .toFinish(YieldOneWorkflowFinish),
  ],
})
export class YieldOneWorkflow {}

@WorkflowStart({
  name: "yield-reviews-workflow-start",
  description: "Items, each reviewed by a child on any instance",
  input: listOf(ItemDto),
})
export class YieldReviewsWorkflowStart {}

@Workflow({
  name: "yield-reviews-workflow",
  version: "1.0.0",
  flow: [
    start(YieldReviewsWorkflowStart)
      .returns(listOf(ItemDto))
      .toParallelWorkflows(YieldReviewWorkflow, {
        maxConcurrency: 2,
        maxItems: 5,
        placement: ChildPlacement.AnyInstance,
      })
      .join()
      .returns(listOf(ItemResultDto))
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class YieldReviewsWorkflow {}

/** Every execution's start and end, by workflow name and execution id. */
@Injectable()
export class YieldLog implements OnExecutionStart, OnExecutionEnd {
  onExecutionStart(event: ExecutionStartEvent): void {
    yieldSeen.starts.push(`${event.workflow.name} ${event.executionId}`);
  }

  onExecutionEnd(event: ExecutionEndEvent): void {
    yieldSeen.ends.push(`${event.workflow.name} ${event.executionId}`);
  }
}

@Application({
  name: "remote-child-yield-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [YieldOneWorkflow, YieldReviewsWorkflow],
  observers: [YieldLog],
  providers: [RecordingLogger],
  budgets: TEST_BUDGETS,
})
export class RemoteChildYieldApplication {}
