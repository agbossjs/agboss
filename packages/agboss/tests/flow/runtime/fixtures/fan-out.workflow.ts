import { AGBossError } from "../../../../src/core/errors.js";
import { Integer, Enum, Text } from "../../../../src/dto/index.js";
import {
  Action,
  EmptyEnvironment,
  ExecutionContext,
  listOf,
  SpendRecorder,
  Workflow,
  WorkflowFinish,
  ExecutionCancelledError,
  WorkflowStart,
  type LaunchItemsTruncatedEvent,
  type Tracked,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { usd } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { onAction, onStart, toFinish, toAction } from "../../../helpers/flow.js";
import { Observer } from "../../../../src/index.js";

/**
 * #273 PR 2 — per-item actions whose timing the test sets: each item waits `delay` ms (or until
 * its launch is aborted), pays a service 0.01 USD first, and fails when its `outcome` says so. The
 * log shows what ran, in what order, how many at once, with which keys and items.
 */

export class ItemDto {
  @Text({ prompt: "the item's name" })
  name!: string;

  @Integer({ prompt: "how long it takes, in ms" })
  delay!: number;

  @Enum(["ok", "fail"], { prompt: "how it ends" })
  outcome!: "ok" | "fail";
}

export class ItemResultDto {
  @Text({ prompt: "the item done" })
  name!: string;
}

export class SummaryDto {
  @Text({ prompt: "what was done" })
  text!: string;
}

/** An item could not be processed: the domain error inside `ActionFailedError`. */
export class ItemFailedError extends AGBossError {
  static override readonly code: string = "test.item-failed";
}

/** What ran: events in order, the most at once, keys and items. */
export const fanOut = {
  events: [] as string[],
  inFlight: 0,
  mostInFlight: 0,
  keys: [] as string[],
  items: [] as (number | undefined)[],
  threads: [] as string[],
  truncated: [] as LaunchItemsTruncatedEvent[],
};

export function resetFanOut(): void {
  fanOut.events.length = 0;
  fanOut.keys.length = 0;
  fanOut.items.length = 0;
  fanOut.threads.length = 0;
  fanOut.truncated.length = 0;
  fanOut.inFlight = 0;
  fanOut.mostInFlight = 0;
}

/** Waits `ms`, or rejects when `signal` aborts first. */
function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });
}

@Action({
  name: "process-item-action",
  description: "Processes one item",
  input: { item: ItemDto },
  output: ItemResultDto,
  deps: [ExecutionContext, SpendRecorder],
})
export class ProcessItemAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly spendRecorder: SpendRecorder,
  ) {}

  async execute(input: { readonly item: Tracked<ItemDto> }): Promise<ItemResultDto> {
    const { name, delay, outcome } = input.item;
    const { step, signal } = this.executionContext;
    fanOut.keys.push(step.idempotencyKey);
    fanOut.items.push(step.itemIndex);
    fanOut.threads.push(this.executionContext.threadId);
    fanOut.events.push(`start ${name}`);
    fanOut.inFlight += 1;
    fanOut.mostInFlight = Math.max(fanOut.mostInFlight, fanOut.inFlight);
    try {
      this.spendRecorder.record({ service: "check-api", cost: usd(0.01) });
      try {
        await waitOrAbort(delay, signal);
      } catch (error) {
        fanOut.events.push(`aborted ${name}`);
        throw error;
      }
      if (outcome === "fail") throw new ItemFailedError(`${name} cannot be processed`);
      fanOut.events.push(`end ${name}`);
      return { name };
    } finally {
      fanOut.inFlight -= 1;
    }
  }
}

@WorkflowStart({
  name: "items-workflow-start",
  description: "The items to process",
  input: listOf(ItemDto),
})
export class ItemsWorkflowStart {}

/** The results in the join's order. */
@Action({
  name: "summary-action",
  description: "What was done",
  input: { results: listOf(ItemResultDto) },
  output: SummaryDto,
})
export class SummaryAction {
  async execute(input: {
    readonly results: readonly Tracked<ItemResultDto>[];
  }): Promise<SummaryDto> {
    const names = input.results.map((result) => result.name);
    return { text: names.join(", ") };
  }
}

@WorkflowFinish({
  name: "summary-workflow-finish",
  description: "What was done",
  output: SummaryDto,
})
export class SummaryWorkflowFinish {}

/** The launch failed on an item: how many items there were. */
@Action({
  name: "items-failed-action",
  description: "The items were not all processed",
  input: { items: listOf(ItemDto) },
  output: SummaryDto,
})
export class ItemsFailedAction {
  async execute(input: { readonly items: readonly Tracked<ItemDto>[] }): Promise<SummaryDto> {
    return { text: `failed on one of ${String(input.items.length)}` };
  }
}

@WorkflowFinish({
  name: "items-failed-workflow-finish",
  description: "The items were not all processed",
  output: SummaryDto,
})
export class ItemsFailedWorkflowFinish {}

@Observer()
export class FanOutLog {
  onLaunchItemsTruncated(event: LaunchItemsTruncatedEvent): void {
    fanOut.truncated.push(event);
  }
}

/** Two at a time, at most four items; an item's failure takes `.onError(…)`. */
@Workflow({
  name: "fan-out-workflow",
  version: "1.0.0",
  flow: [
    onStart(ItemsWorkflowStart)
      .forEachItem(toAction(ProcessItemAction), { takeFirst: 4, maxConcurrency: 2 })
      .join()
      .onError(ItemFailedError, toAction(ItemsFailedAction))
      // never taken: a cancel of the execution stops it whole (S21)
      .onError(ExecutionCancelledError, toAction(ItemsFailedAction))
      .toAction(SummaryAction)
      .toFinish(SummaryWorkflowFinish),
    onAction(ItemsFailedAction)
      .toFinish(ItemsFailedWorkflowFinish),
  ],
})
export class FanOutWorkflow {}

@Application({
  name: "fan-out-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FanOutWorkflow],
  observers: [FanOutLog],
  budgets: TEST_BUDGETS,
})
export class FanOutApplication {}

/** All at once, no handler: a failed item fails the execution. */
@Workflow({
  name: "fan-out-unbounded-workflow",
  version: "1.0.0",
  flow: [
    onStart(ItemsWorkflowStart)
      .forEachItem(toAction(ProcessItemAction), { takeFirst: 4 })
      .join()
      .toAction(SummaryAction)
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class FanOutUnboundedWorkflow {}

@Application({
  name: "fan-out-unbounded-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FanOutUnboundedWorkflow],
  budgets: TEST_BUDGETS,
})
export class FanOutUnboundedApplication {}

/** A finish whose output is a list (#1271): the join's values pass straight through, no wrapper DTO. */
@WorkflowFinish({
  name: "item-results-workflow-finish",
  description: "Every item's result, in the join's order",
  output: listOf(ItemResultDto),
})
export class ItemResultsWorkflowFinish {}

@Workflow({
  name: "list-finish-workflow",
  version: "1.0.0",
  executionLimits: { maxSteps: 10 },
  flow: [
    onStart(ItemsWorkflowStart)
      .forEachItem(toAction(ProcessItemAction), { takeFirst: 4 })
      .join()
      .toFinish(ItemResultsWorkflowFinish),
  ],
})
export class ListFinishWorkflow {}

@Application({
  name: "list-finish-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ListFinishWorkflow],
  budgets: TEST_BUDGETS,
})
export class ListFinishApplication {}

/** Which copy ran: what the step's `ExecutionContext` said (AC1: `step.copyNumber` from 1). */
export class StampDto {
  @Text({ prompt: "the copy's node id" })
  nodeId!: string;

  @Integer({ prompt: "the copy's number" })
  copyNumber!: number;

  @Integer({ prompt: "the visit's number" })
  visitNumber!: number;
}

@Action({
  name: "stamp-action",
  description: "Says which copy it is",
  input: { item: ItemDto },
  output: StampDto,
  deps: [ExecutionContext],
})
export class StampAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(): Promise<StampDto> {
    const { nodeId, copyNumber, visitNumber } = this.executionContext.step;
    return Promise.resolve({ nodeId, copyNumber, visitNumber });
  }
}

@WorkflowStart({ name: "one-item-workflow-start", description: "One item", input: ItemDto })
export class OneItemWorkflowStart {}

@Action({
  name: "stamps-action",
  description: "Which copies ran",
  input: { stamps: listOf(StampDto) },
  output: SummaryDto,
})
export class StampsAction {
  async execute(input: { readonly stamps: readonly Tracked<StampDto>[] }): Promise<SummaryDto> {
    const said = input.stamps.map((stamp) =>
      [stamp.nodeId, String(stamp.copyNumber), String(stamp.visitNumber)].join(" "),
    );
    return { text: said.join("; ") };
  }
}

@WorkflowFinish({
  name: "stamps-workflow-finish",
  description: "Which copies ran",
  output: SummaryDto,
})
export class StampsWorkflowFinish {}

/** One action listed twice: two copies. */
@Workflow({
  name: "copies-workflow",
  version: "1.0.0",
  flow: [
    onStart(OneItemWorkflowStart)
      .inParallel([toAction(StampAction), toAction(StampAction)])
      .join()
      .toAction(StampsAction)
      .toFinish(StampsWorkflowFinish),
  ],
})
export class CopiesWorkflow {}

@Application({
  name: "copies-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CopiesWorkflow],
  budgets: TEST_BUDGETS,
})
export class CopiesApplication {}
