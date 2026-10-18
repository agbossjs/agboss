import { AGBossError } from "../../../../src/core/errors.js";
import { Integer, OneOf, Text } from "../../../../src/dto/index.js";
import {
  Action,
  EmptyEnvironment,
  ExecutionContext,
  listOf,
  SpendRecorder,
  Workflow,
  WorkflowFinish,
  WorkflowCancelledError,
  WorkflowStart,
  type LaunchItemsTruncatedEvent,
  type OnLaunchItemsTruncated,
  type Produced,
} from "../../../../src/index.js";
import { Injectable } from "../../../../src/components/decorators.js";
import { Application } from "../../../../src/application/application.js";
import { usd } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { start, toFinish } from "../../../helpers/flow.js";

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

  @OneOf({ values: ["ok", "fail"], prompt: "how it ends" })
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

  async execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<ItemResultDto> {
    const { name, delay, outcome } = input.item.value;
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
@WorkflowFinish({
  name: "summary-workflow-finish",
  description: "What was done",
  input: { results: listOf(ItemResultDto) },
  output: SummaryDto,
})
export class SummaryWorkflowFinish {
  finish(input: { readonly results: readonly Produced<ItemResultDto, unknown>[] }): SummaryDto {
    const names = input.results.map((result) => result.value.name);
    return { text: names.join(", ") };
  }
}

/** The launch failed on an item: how many items there were. */
@WorkflowFinish({
  name: "items-failed-workflow-finish",
  description: "The items were not all processed",
  input: { items: listOf(ItemDto) },
  output: SummaryDto,
})
export class ItemsFailedWorkflowFinish {
  finish(input: { readonly items: readonly Produced<ItemDto, unknown>[] }): SummaryDto {
    return { text: `failed on one of ${String(input.items.length)}` };
  }
}

@Injectable()
export class FanOutLog implements OnLaunchItemsTruncated {
  onLaunchItemsTruncated(event: LaunchItemsTruncatedEvent): void {
    fanOut.truncated.push(event);
  }
}

/** Two at a time, at most four items; an item's failure takes `.onJoinError(…)`. */
@Workflow({
  name: "fan-out-workflow",
  version: "1.0.0",
  observers: [FanOutLog],
  flow: [
    start(ItemsWorkflowStart)
      .returns(listOf(ItemDto))
      .toParallelActions(ProcessItemAction, { maxConcurrency: 2, maxItems: 4 })
      .join()
      .onJoinError(ItemFailedError, toFinish(ItemsFailedWorkflowFinish))
      // never taken: a cancel of the execution stops it whole (S21)
      .onJoinError(WorkflowCancelledError, toFinish(ItemsFailedWorkflowFinish))
      .returns(listOf(ItemResultDto))
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class FanOutWorkflow {}

@Application({
  name: "fan-out-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FanOutWorkflow],
  budgets: TEST_BUDGETS,
})
export class FanOutApplication {}

/** All at once, no handler: a failed item fails the execution. */
@Workflow({
  name: "fan-out-unbounded-workflow",
  version: "1.0.0",
  flow: [
    start(ItemsWorkflowStart)
      .returns(listOf(ItemDto))
      .toParallelActions(ProcessItemAction, { maxItems: 4 })
      .join()
      .returns(listOf(ItemResultDto))
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

@WorkflowFinish({
  name: "stamps-workflow-finish",
  description: "Which copies ran",
  input: { stamps: listOf(StampDto) },
  output: SummaryDto,
})
export class StampsWorkflowFinish {
  finish(input: { readonly stamps: readonly Produced<StampDto, unknown>[] }): SummaryDto {
    const said = input.stamps.map(({ value }) =>
      [value.nodeId, String(value.copyNumber), String(value.visitNumber)].join(" "),
    );
    return { text: said.join("; ") };
  }
}

/** One action listed twice: two copies. */
@Workflow({
  name: "copies-workflow",
  version: "1.0.0",
  flow: [
    start(OneItemWorkflowStart)
      .returns(ItemDto)
      .toParallelActions(StampAction, StampAction)
      .join()
      .returns(listOf(StampDto))
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
