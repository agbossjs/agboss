import {
  Action,
  ChildPlacement,
  EmptyEnvironment,
  ExecutionContext,
  Injectable,
  SpendRecorder,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  listOf,
  type ExecutionStartEvent,
  type OnExecutionStart,
  type Produced,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { InMemoryCostLedgerRepository } from "../../../src/infrastructure/cost-ledger.repository.js";
import type { CostCounter } from "../../../src/infrastructure/cost-ledger.repository.js";
import type { UsageRecord } from "../../../src/finops/usage.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { usd } from "../../../src/units/index.js";
import {
  ItemDto,
  ItemResultDto,
  SummaryWorkflowFinish,
} from "../../flow/runtime/fixtures/fan-out.workflow.js";

/**
 * #776 — a child on any instance is queued only once the tree's spend so far is in the ledger, also
 * the spend a sibling branch makes after the launching step's own checkpoint (#732: the
 * `settled()` in `remoteChildEndOf`, which the checkpoint gating does not cover). Under
 * `TEST_BUDGETS` (an execution may spend $100), two items, each a child on the parent's instance:
 *
 * - item `b` pays nothing and launches a grandchild on any instance (`grand-pay-workflow`: $50,
 *   then $50). The grandchild's `onExecutionStart` — after `b`'s checkpoint, before its queueing —
 *   waits until item `a` has paid.
 * - item `a` waits for that, pays $60, then works until its step is stopped. The ledger holds the
 *   write of `a`'s $60 until the test lets it go.
 *
 * Queued only once the $60 is written, the grandchild's second $50 is held back at $110. Queued
 * beside the pending write, its worker reads $0 and $50 and pays both: $160 of $100.
 */

export const siblingSpend = {
  /** Every paid step that ran, `<item>:<step>`. */
  ran: [] as string[],
  /** Resolved once the grandchild of `b` is about to be queued. */
  queuing: Promise.resolve(),
  /** Resolved once `a` has paid. */
  paid: Promise.resolve(),
  /** The ledger holds the write of `a`'s pay until this resolves. */
  held: Promise.resolve(),
  /** Whether the ledger has written `a`'s pay. */
  isPayWritten: false,
};

/** Fresh gates; `release` lets the ledger write `a`'s pay. */
export function resetSiblingSpend(): { readonly release: () => void } {
  siblingSpend.ran.length = 0;
  siblingSpend.isPayWritten = false;
  let release = (): void => undefined;
  siblingSpend.held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let queued = (): void => undefined;
  siblingSpend.queuing = new Promise<void>((resolve) => {
    queued = resolve;
  });
  let paid = (): void => undefined;
  siblingSpend.paid = new Promise<void>((resolve) => {
    paid = resolve;
  });
  gates.queued = queued;
  gates.paid = paid;
  return { release };
}

const gates = { queued: (): void => undefined, paid: (): void => undefined };

/** A ledger that holds the write of `a`'s pay until the test lets it go. */
export class HeldSiblingLedger extends InMemoryCostLedgerRepository {
  override async saveAll(
    counters: readonly CostCounter[],
    records: readonly UsageRecord[],
  ): Promise<void> {
    if (records.some((record) => record.caller.includes("sibling-pay-action"))) {
      await siblingSpend.held;
      siblingSpend.isPayWritten = true;
    }
    return super.saveAll(counters, records);
  }
}

/** The grandchild's start: `b`'s queueing waits here until `a` has paid. */
@Injectable()
export class GrandStartObserver implements OnExecutionStart {
  async onExecutionStart(event: ExecutionStartEvent): Promise<void> {
    if (event.workflow.name !== "grand-pay-workflow") return;
    gates.queued();
    await siblingSpend.paid;
  }
}

/** Rejects when the step is stopped; never resolves otherwise. */
const untilStopped = (signal: AbortSignal): Promise<void> =>
  new Promise((_resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("the step was stopped"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });

@Action({
  name: "sibling-pay-action",
  description: "Item a pays $60 once b's grandchild is about to be queued, then works on",
  input: { item: ItemDto },
  output: ItemDto,
  deps: [SpendRecorder, ExecutionContext],
})
export class SiblingPayAction {
  constructor(
    private readonly spendRecorder: SpendRecorder,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<ItemDto> {
    const item = input.item.value;
    if (item.name !== "a") return item;
    await siblingSpend.queuing;
    siblingSpend.ran.push("a:sibling-pay");
    this.spendRecorder.record({ service: "pay-api", cost: usd(60) });
    gates.paid();
    await untilStopped(this.executionContext.signal);
    return item;
  }
}

function grandPayOf(step: string) {
  @Action({
    name: `grand-${step}-action`,
    description: "The grandchild pays $50",
    input: { item: ItemDto },
    output: ItemDto,
    deps: [SpendRecorder],
  })
  class GrandPay {
    constructor(private readonly spendRecorder: SpendRecorder) {}

    execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<ItemDto> {
      siblingSpend.ran.push(`${input.item.value.name}:grand-${step}`);
      this.spendRecorder.record({ service: "pay-api", cost: usd(50) });
      return Promise.resolve(input.item.value);
    }
  }
  return GrandPay;
}

const GrandOne = grandPayOf("one");
const GrandTwo = grandPayOf("two");

@Action({
  name: "grand-done-action",
  description: "The item is done",
  input: { item: ItemDto },
  output: ItemResultDto,
})
class GrandDoneAction {
  execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<ItemResultDto> {
    return Promise.resolve({ name: input.item.value.name });
  }
}

@WorkflowStart({ name: "grand-pay-workflow-start", description: "One item", input: ItemDto })
class GrandPayWorkflowStart {}
@WorkflowFinish({ name: "grand-pay-workflow-finish", description: "Paid", output: ItemResultDto })
class GrandPayWorkflowFinish {}
@Workflow({
  name: "grand-pay-workflow",
  version: "1.0.0",
  flow: [
    start(GrandPayWorkflowStart)
      .returns(ItemDto)
      .toAction(GrandOne)
      .returns(ItemDto)
      .toAction(GrandTwo)
      .returns(ItemDto)
      .toAction(GrandDoneAction)
      .returns(ItemResultDto)
      .toFinish(GrandPayWorkflowFinish),
  ],
})
class GrandPayWorkflow {}

@WorkflowStart({ name: "sibling-item-workflow-start", description: "One item", input: ItemDto })
class SiblingItemWorkflowStart {}
@WorkflowFinish({
  name: "sibling-item-workflow-finish",
  description: "Paid",
  output: ItemResultDto,
})
class SiblingItemWorkflowFinish {}
@Workflow({
  name: "sibling-item-workflow",
  version: "1.0.0",
  flow: [
    start(SiblingItemWorkflowStart)
      .returns(ItemDto)
      .toAction(SiblingPayAction)
      .returns(ItemDto)
      .toWorkflow(GrandPayWorkflow, { placement: ChildPlacement.AnyInstance })
      .returns(ItemResultDto)
      .toFinish(SiblingItemWorkflowFinish),
  ],
})
class SiblingItemWorkflow {}

@WorkflowStart({
  name: "sibling-items-workflow-start",
  description: "Items",
  input: listOf(ItemDto),
})
export class SiblingItemsWorkflowStart {}

@Workflow({
  name: "sibling-items-workflow",
  version: "1.0.0",
  flow: [
    start(SiblingItemsWorkflowStart)
      .returns(listOf(ItemDto))
      .toParallelWorkflows(SiblingItemWorkflow, {
        maxItems: 2,
        placement: ChildPlacement.ParentInstance,
      })
      .join()
      .returns(listOf(ItemResultDto))
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class SiblingItemsWorkflow {}

@Application({
  name: "sibling-spend-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SiblingItemsWorkflow],
  budgets: TEST_BUDGETS,
  observers: [GrandStartObserver],
  providers: [HeldSiblingLedger],
})
export class SiblingSpendApplication {}
