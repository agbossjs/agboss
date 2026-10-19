import { TerminalUserChannel } from "../../../../src/channels/terminal-channel.js";
import { Text } from "../../../../src/dto/index.js";
import {
  Action,
  Agent,
  ChildExecutionFailedError,
  EmptyEnvironment,
  ExecutionContext,
  listOf,
  oneOf,
  SpendRecorder,
  StepFailedError,
  StepsLimitExceededError,
  TenantContext,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ExecutionEndEvent,
  type ExecutionErrorEvent,
  type ExecutionStartEvent,
  type OnExecutionEnd,
  type OnExecutionError,
  type OnExecutionStart,
  type Produced,
  type ToolHandler,
} from "../../../../src/index.js";
import { Injectable } from "../../../../src/components/decorators.js";
import { Application } from "../../../../src/application/application.js";
import { usd, type Usd } from "../../../../src/units/index.js";
import { Budget, BudgetScope, type BudgetHandler } from "../../../../src/budgets/budget.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { agent, caseOf, start, toAgent, toFinish, toWorkflow } from "../../../helpers/flow.js";
import { ItemDto, ItemFailedError, ItemResultDto, SummaryDto } from "./fan-out.workflow.js";

/**
 * #263 PR 2 — child workflows at run time. A code child (`item-check-workflow`: one action that
 * logs what its `ExecutionContext` says, pays a service, waits `delay` ms or until aborted, and
 * fails on `outcome: "fail"`) and a model child (`item-review-workflow`: an agent that answers
 * `ItemResultDto`, or `ItemNoteDto` to go round again — `maxSteps: 2` — and may ask for a
 * confirmation); parents that launch them per item, once, from an `.onError` side path (S85).
 */

export class ShopTenantContext extends TenantContext {
  @Text()
  plan!: string;
}

export class ShopExecutionContext extends ExecutionContext {
  @Text()
  userId!: string;
}

export class ItemNoteDto {
  @Text({ prompt: "what to look at again" })
  note!: string;
}

/** What a child's step saw of its execution and its tree. */
export interface ChildReading {
  readonly item: string;
  readonly executionId: string;
  readonly parentExecutionId: string | undefined;
  readonly rootExecutionId: string;
  readonly depth: number;
  readonly itemIndex: number | undefined;
  readonly parentStep: string | undefined;
  readonly checksItemIndex: number | undefined;
  readonly deepItemIndex: number | undefined;
  readonly rootWorkflow: string;
  readonly tenantId: string;
  readonly plan: string;
  readonly userId: string;
  readonly threadId: string;
  readonly key: string;
}

/** What ran: the readings, the most items in flight, the child execution events. */
export const childLog = {
  readings: [] as ChildReading[],
  events: [] as string[],
  inFlight: 0,
  mostInFlight: 0,
  starts: [] as ExecutionStartEvent[],
  ends: [] as ExecutionEndEvent[],
  errors: [] as ExecutionErrorEvent[],
  /** The producers of the values the checks' summary read. */
  producers: [] as unknown[],
};

export function resetChildLog(): void {
  childLog.readings.length = 0;
  childLog.events.length = 0;
  childLog.starts.length = 0;
  childLog.ends.length = 0;
  childLog.errors.length = 0;
  childLog.producers.length = 0;
  childLog.inFlight = 0;
  childLog.mostInFlight = 0;
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
  name: "check-item-action",
  description: "Checks one item",
  input: { item: ItemDto },
  output: ItemResultDto,
  deps: [ShopExecutionContext, SpendRecorder],
})
export class CheckItemAction {
  constructor(
    private readonly executionContext: ShopExecutionContext,
    private readonly spendRecorder: SpendRecorder,
  ) {}

  async execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<ItemResultDto> {
    const { name, delay, outcome } = input.item.value;
    this.read(name);
    childLog.events.push(`start ${name}`);
    childLog.inFlight += 1;
    childLog.mostInFlight = Math.max(childLog.mostInFlight, childLog.inFlight);
    try {
      this.spendRecorder.record({ service: "check-api", cost: usd(0.01) });
      try {
        await waitOrAbort(delay, this.executionContext.signal);
      } catch (error) {
        childLog.events.push(`aborted ${name}`);
        throw error;
      }
      if (outcome === "fail") throw new ItemFailedError(`${name} cannot be checked`);
      childLog.events.push(`end ${name}`);
      return { name };
    } finally {
      childLog.inFlight -= 1;
    }
  }

  private read(item: string): void {
    const context = this.executionContext;
    childLog.readings.push({
      item,
      executionId: context.executionId,
      parentExecutionId: context.parent?.executionId,
      rootExecutionId: context.root.executionId,
      depth: context.depth,
      itemIndex: context.itemIndex,
      parentStep: context.parent?.step.nodeId,
      checksItemIndex: context.executionOf(ItemCheckWorkflow)?.itemIndex,
      deepItemIndex: context.executionOf(ItemDeepCheckWorkflow)?.itemIndex,
      rootWorkflow: context.root.workflow.name,
      tenantId: context.tenant.tenantId,
      plan: (context.tenant as ShopTenantContext).plan,
      userId: context.userId,
      threadId: context.threadId,
      key: context.step.idempotencyKey,
    });
  }
}

@WorkflowStart({
  name: "item-check-workflow-start",
  description: "One item to check",
  input: ItemDto,
})
export class ItemCheckWorkflowStart {}

@WorkflowFinish({
  name: "item-checked-workflow-finish",
  description: "The item is checked",
  output: ItemResultDto,
})
export class ItemCheckedWorkflowFinish {}

/** The code child: one item, one action; an uncaught failure fails it. */
@Workflow({
  name: "item-check-workflow",
  version: "1.0.0",
  flow: [
    start(ItemCheckWorkflowStart)
      .returns(ItemDto)
      .toAction(CheckItemAction)
      .returns(ItemResultDto)
      .toFinish(ItemCheckedWorkflowFinish),
  ],
})
export class ItemCheckWorkflow {}

// ── parents of the code child ──

@WorkflowStart({
  name: "check-items-workflow-start",
  description: "The items to check",
  input: listOf(ItemDto),
})
export class CheckItemsWorkflowStart {}

@WorkflowFinish({
  name: "checks-summary-workflow-finish",
  description: "What was checked",
  input: { results: listOf(ItemResultDto) },
  output: SummaryDto,
})
export class ChecksSummaryWorkflowFinish {
  finish(input: { readonly results: readonly Produced<ItemResultDto, unknown>[] }): SummaryDto {
    childLog.producers.push(...input.results.map((result) => result.producer));
    return {
      text: input.results
        .map((result) => result.value.name)
        .join(", "),
    };
  }
}

/** The launch failed: what the side path sees is the scope before the launch — the items. */
@WorkflowFinish({
  name: "checks-failed-workflow-finish",
  description: "The items were not all checked",
  input: { items: listOf(ItemDto) },
  output: SummaryDto,
})
export class ChecksFailedWorkflowFinish {
  finish(input: { readonly items: readonly Produced<ItemDto, unknown>[] }): SummaryDto {
    return { text: `failed on one of ${String(input.items.length)}` };
  }
}

/** One child per item, two at a time; a failed child is caught by its class. */
@Workflow({
  name: "check-items-workflow",
  version: "1.0.0",
  flow: [
    start(CheckItemsWorkflowStart)
      .returns(listOf(ItemDto))
      .toParallelWorkflows(ItemCheckWorkflow, { maxConcurrency: 2, maxItems: 10 })
      .join()
      .onJoinError(ChildExecutionFailedError, toFinish(ChecksFailedWorkflowFinish))
      .returns(listOf(ItemResultDto))
      .toFinish(ChecksSummaryWorkflowFinish),
  ],
})
export class CheckItemsWorkflow {}

@WorkflowStart({
  name: "check-one-workflow-start",
  description: "One item",
  input: ItemDto,
})
export class CheckOneWorkflowStart {}

@WorkflowFinish({
  name: "one-checked-workflow-finish",
  description: "The item, checked",
  output: ItemResultDto,
})
export class OneCheckedWorkflowFinish {}

@WorkflowFinish({
  name: "one-failed-workflow-finish",
  description: "The item could not be checked",
  input: { item: ItemDto },
  output: SummaryDto,
})
export class OneFailedWorkflowFinish {
  finish(input: { readonly item: Produced<ItemDto, unknown> }): SummaryDto {
    return { text: `could not check ${input.item.value.name}` };
  }
}

/** One child, one way in: its failure is caught right after it by the cause's class. */
@Workflow({
  name: "check-one-workflow",
  version: "1.0.0",
  flow: [
    start(CheckOneWorkflowStart)
      .returns(ItemDto)
      .toWorkflow(ItemCheckWorkflow)
      .onError(ItemFailedError, toFinish(OneFailedWorkflowFinish))
      .returns(ItemResultDto)
      .toFinish(OneCheckedWorkflowFinish),
  ],
})
export class CheckOneWorkflow {}

@WorkflowStart({
  name: "check-bare-workflow-start",
  description: "One item, no handler",
  input: ItemDto,
})
export class CheckBareWorkflowStart {}

/** One child, no handler: its failure fails the execution. */
@Workflow({
  name: "check-bare-workflow",
  version: "1.0.0",
  flow: [
    start(CheckBareWorkflowStart)
      .returns(ItemDto)
      .toWorkflow(ItemCheckWorkflow)
      .returns(ItemResultDto)
      .toFinish(OneCheckedWorkflowFinish),
  ],
})
export class CheckBareWorkflow {}

// ── a grandchild: a per-item child that runs the code child once ──

@WorkflowStart({
  name: "item-deep-check-workflow-start",
  description: "One item, checked through a child",
  input: ItemDto,
})
export class ItemDeepCheckWorkflowStart {}

@WorkflowFinish({
  name: "item-deep-checked-workflow-finish",
  description: "The item, checked through a child",
  output: ItemResultDto,
})
export class ItemDeepCheckedWorkflowFinish {}

@Workflow({
  name: "item-deep-check-workflow",
  version: "1.0.0",
  flow: [
    start(ItemDeepCheckWorkflowStart)
      .returns(ItemDto)
      .toWorkflow(ItemCheckWorkflow)
      .returns(ItemResultDto)
      .toFinish(ItemDeepCheckedWorkflowFinish),
  ],
})
export class ItemDeepCheckWorkflow {}

@WorkflowStart({
  name: "deep-check-items-workflow-start",
  description: "The items to check through children",
  input: listOf(ItemDto),
})
export class DeepCheckItemsWorkflowStart {}

@Workflow({
  name: "deep-check-items-workflow",
  version: "1.0.0",
  flow: [
    start(DeepCheckItemsWorkflowStart)
      .returns(listOf(ItemDto))
      .toParallelWorkflows(ItemDeepCheckWorkflow, { maxItems: 10 })
      .join()
      .returns(listOf(ItemResultDto))
      .toFinish(ChecksSummaryWorkflowFinish),
  ],
})
export class DeepCheckItemsWorkflow {}

// ── a child as an error handler (S85) ──

@Action({
  name: "fallback-check-action",
  description: "Checks an item the slow way",
  input: { item: ItemDto },
  output: ItemResultDto,
})
export class FallbackCheckAction {
  execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<ItemResultDto> {
    return Promise.resolve({ name: `${input.item.value.name} (fallback)` });
  }
}

@WorkflowStart({
  name: "fallback-check-workflow-start",
  description: "An item the first check failed on",
  input: ItemDto,
})
export class FallbackCheckWorkflowStart {}

@WorkflowFinish({
  name: "fallback-checked-workflow-finish",
  description: "The item, checked the slow way",
  output: ItemResultDto,
})
export class FallbackCheckedWorkflowFinish {}

@Workflow({
  name: "fallback-check-workflow",
  version: "1.0.0",
  flow: [
    start(FallbackCheckWorkflowStart)
      .returns(ItemDto)
      .toAction(FallbackCheckAction)
      .returns(ItemResultDto)
      .toFinish(FallbackCheckedWorkflowFinish),
  ],
})
export class FallbackCheckWorkflow {}

@WorkflowStart({
  name: "check-or-fallback-workflow-start",
  description: "One item, with a fallback",
  input: ItemDto,
})
export class CheckOrFallbackWorkflowStart {}

@WorkflowFinish({
  name: "rechecked-workflow-finish",
  description: "The item, checked by the fallback",
  output: ItemResultDto,
})
export class RecheckedWorkflowFinish {}

/** The first check's failure goes to a child workflow: `.onError(E, toWorkflow(W)…)`. */
@Workflow({
  name: "check-or-fallback-workflow",
  version: "1.0.0",
  flow: [
    start(CheckOrFallbackWorkflowStart)
      .returns(ItemDto)
      .toAction(CheckItemAction)
      .onError(
        StepFailedError,
        toWorkflow(FallbackCheckWorkflow)
          .returns(ItemResultDto)
          .toFinish(RecheckedWorkflowFinish),
      )
      .returns(ItemResultDto)
      .toFinish(OneCheckedWorkflowFinish),
  ],
})
export class CheckOrFallbackWorkflow {}

// ── the model child: an agent that may go round again or ask for a confirmation ──

export class ItemConfirmationDto {
  @Text({ prompt: "the item to confirm" })
  name!: string;
}

@Tool({
  name: "confirm_review",
  description: "Confirms an item's review",
  channel: TerminalUserChannel,
  input: ItemConfirmationDto,
  output: ItemConfirmationDto,
})
export class ConfirmReviewTool implements ToolHandler<ItemConfirmationDto, ItemConfirmationDto> {
  run(input: ItemConfirmationDto): Promise<ItemConfirmationDto> {
    return Promise.resolve(input);
  }
}

@Agent({
  name: "item-reviewer-agent",
  description: "Reviews one item",
  prompt: "Review the item.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 5,
  tools: [ConfirmReviewTool],
  input: { item: ItemDto },
  output: oneOf(ItemResultDto, ItemNoteDto),
})
export class ItemReviewerAgent {}

@WorkflowStart({
  name: "item-review-workflow-start",
  description: "One item to review",
  input: ItemDto,
})
export class ItemReviewWorkflowStart {}

@WorkflowFinish({
  name: "item-reviewed-workflow-finish",
  description: "The item, reviewed",
  output: ItemResultDto,
})
export class ItemReviewedWorkflowFinish {}

@Workflow({
  name: "item-review-workflow",
  version: "1.0.0",
  maxSteps: 2,
  flow: [
    start(ItemReviewWorkflowStart)
      .returns(ItemDto)
      .toAgent(ItemReviewerAgent),
    agent(ItemReviewerAgent)
      .returns(oneOf(ItemResultDto, ItemNoteDto))
      .switch(
        caseOf(ItemResultDto)
          .toFinish(ItemReviewedWorkflowFinish),
        caseOf(ItemNoteDto)
          .toAgent(ItemReviewerAgent),
      ),
  ],
})
export class ItemReviewWorkflow {}

@WorkflowStart({
  name: "review-items-workflow-start",
  description: "The items to review",
  input: listOf(ItemDto),
})
export class ReviewItemsWorkflowStart {}

@Agent({
  name: "review-rescue-agent",
  description: "Says what to do when a review ran out of steps",
  prompt: "Say what to do.",
  model: "moonshotai/kimi-k2.6",
  input: { items: listOf(ItemDto) },
  output: SummaryDto,
})
export class ReviewRescueAgent {}

@WorkflowFinish({
  name: "reviews-workflow-finish",
  description: "The reviews, or what to do instead",
  output: SummaryDto,
})
export class ReviewsWorkflowFinish {}

@WorkflowFinish({
  name: "reviews-summary-workflow-finish",
  description: "What was reviewed",
  input: { results: listOf(ItemResultDto) },
  output: SummaryDto,
})
export class ReviewsSummaryWorkflowFinish {
  finish(input: { readonly results: readonly Produced<ItemResultDto, unknown>[] }): SummaryDto {
    return {
      text: input.results
        .map((result) => result.value.name)
        .join(", "),
    };
  }
}

/** A child over its own maxSteps is a child's failure: its handler may lead to an agent (S25). */
@Workflow({
  name: "review-items-workflow",
  version: "1.0.0",
  maxSteps: 4,
  flow: [
    start(ReviewItemsWorkflowStart)
      .returns(listOf(ItemDto))
      .toParallelWorkflows(ItemReviewWorkflow, { maxConcurrency: 2, maxItems: 10 })
      .join()
      .onJoinError(
        ChildExecutionFailedError,
        toAgent(ReviewRescueAgent)
          .returns(SummaryDto)
          .toFinish(ReviewsWorkflowFinish),
      )
      .returns(listOf(ItemResultDto))
      .toFinish(ReviewsSummaryWorkflowFinish),
  ],
})
export class ReviewItemsWorkflow {}

@WorkflowStart({
  name: "review-one-workflow-start",
  description: "One item to review",
  input: ItemDto,
})
export class ReviewOneWorkflowStart {}

@WorkflowFinish({
  name: "review-stopped-workflow-finish",
  description: "The review stopped on its steps",
  input: { item: ItemDto },
  output: SummaryDto,
})
export class ReviewStoppedWorkflowFinish {
  finish(input: { readonly item: Produced<ItemDto, unknown> }): SummaryDto {
    return { text: `stopped on ${input.item.value.name}` };
  }
}

/** A handler naming the limit catches the child's limit through the cause chain. */
@Workflow({
  name: "review-one-workflow",
  version: "1.0.0",
  flow: [
    start(ReviewOneWorkflowStart)
      .returns(ItemDto)
      .toWorkflow(ItemReviewWorkflow)
      .onError(StepsLimitExceededError, toFinish(ReviewStoppedWorkflowFinish))
      .returns(ItemResultDto)
      .toFinish(ItemReviewedWorkflowFinish),
  ],
})
export class ReviewOneWorkflow {}

/** Every child execution event, in order. */
@Injectable()
export class ChildEventLog implements OnExecutionStart, OnExecutionEnd, OnExecutionError {
  onExecutionStart(event: ExecutionStartEvent): void {
    childLog.starts.push(event);
  }

  onExecutionEnd(event: ExecutionEndEvent): void {
    childLog.ends.push(event);
  }

  onExecutionError(event: ExecutionErrorEvent): void {
    childLog.errors.push(event);
  }
}

@Application({
  name: "children-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  tenantContext: ShopTenantContext,
  executionContext: ShopExecutionContext,
  workflows: [
    CheckItemsWorkflow,
    CheckOneWorkflow,
    CheckBareWorkflow,
    CheckOrFallbackWorkflow,
    DeepCheckItemsWorkflow,
    ReviewItemsWorkflow,
    ReviewOneWorkflow,
    ItemReviewWorkflow,
  ],
  observers: [ChildEventLog],
  budgets: TEST_BUDGETS,
})
export class ChildrenApplication {}

/** The model child's own execution budget: applies only when it runs as the root. */
@Budget({
  name: "item-review-execution-budget",
  scope: BudgetScope.Execution,
  workflow: ItemReviewWorkflow,
})
export class ItemReviewExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

/** The model child and its parent, with the child's own execution budget. */
@Application({
  name: "child-budgets-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  tenantContext: ShopTenantContext,
  executionContext: ShopExecutionContext,
  workflows: [ReviewOneWorkflow, ReviewItemsWorkflow, ItemReviewWorkflow],
  observers: [ChildEventLog],
  budgets: [...TEST_BUDGETS, ItemReviewExecutionBudget],
})
export class ChildBudgetsApplication {}
