import {
  Action,
  ChildPlacement,
  EmptyEnvironment,
  ExecutionContext,
  SpendRecorder,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  listOf,
  type Class,
  type Produced,
} from "../../../src/index.js";
import { MemorySaver } from "@langchain/langgraph";
import { Application } from "../../../src/application/application.js";
import { Injectable } from "../../../src/components/decorators.js";
import {
  InMemoryCostLedgerRepository,
  type LedgerEntry,
} from "../../../src/infrastructure/cost-ledger.repository.js";
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
 * #727, #732 — a tree's spend while it is in flight, seen by the tree's own steps on any instance.
 * Under `TEST_BUDGETS` (an execution may spend $100):
 *
 * - #727: two sibling children per item, each `pay-one → pay-two → pay-three → done`; item `a`'s
 *   `pay-one` pays $60 and then works on until the test lets it go, item `b`'s steps pay $30 each.
 *   On the parent's instance and on any instance alike, `b` runs `pay-one` and `pay-two` while `a`
 *   works, and its `pay-three` is held back at $120.
 * - #732: the parent's `parent-pay` pays $90, then a child on any instance pays $30 twice; the
 *   ledger holds the write of the parent's $90 until the test lets it go. The child's second step
 *   is held back at $120, even while that write is pending.
 */

export const inFlight = {
  /** Every paid step that ran, `<item>:<step>`. */
  ran: [] as string[],
  /** The instance each paid step ran on, by `<item>:<step>`. */
  where: new Map<string, string>(),
  /** Item `a`'s first step works until this resolves (or its step is aborted). */
  working: Promise.resolve(),
  /** The ledger holds a write of the parent's `parent-pay` until this resolves. */
  parentWrite: Promise.resolve(),
  /** Whether the ledger has written the parent's `parent-pay` yet. */
  isParentPayWritten: false,
  /** Checkpoint writes that held the parent's `parent-pay` before the ledger did (#727). */
  durableBeforeLedger: [] as string[],
};

export function resetInFlight(): { readonly release: () => void } {
  inFlight.ran.length = 0;
  inFlight.where.clear();
  inFlight.isParentPayWritten = false;
  inFlight.durableBeforeLedger.length = 0;
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  inFlight.working = held;
  inFlight.parentWrite = held;
  return { release };
}

/** Whether a ledger write holds the parent's own spend (#732): held until the test lets it go. */
export async function holdsParentPay(records: readonly UsageRecord[]): Promise<void> {
  if (!records.some((record) => record.caller.includes("parent-pay"))) return;
  await inFlight.parentWrite;
  inFlight.isParentPayWritten = true;
}

/** Notes a checkpoint write that holds the parent's `parent-pay` before the ledger has it. */
const watched = (kind: string, written: unknown): void => {
  if (!inFlight.isParentPayWritten && JSON.stringify(written).includes("action:parent-pay-action"))
    inFlight.durableBeforeLedger.push(kind);
};

/** The checkpoints in memory, every write of them watched for spend the ledger lacks (#727). */
@Injectable()
export class WatchedCheckpointSaver extends MemorySaver {
  override put(...written: Parameters<MemorySaver["put"]>): ReturnType<MemorySaver["put"]> {
    watched("put", written[1]);
    return super.put(...written);
  }

  override putWrites(
    ...written: Parameters<MemorySaver["putWrites"]>
  ): ReturnType<MemorySaver["putWrites"]> {
    watched("putWrites", written[1]);
    return super.putWrites(...written);
  }
}

/** A ledger that holds the write of the parent's own spend (#732) until the test lets it go. */
export class HeldParentLedger extends InMemoryCostLedgerRepository {
  override async saveAll(
    counters: readonly CostCounter[],
    records: readonly LedgerEntry[],
  ): Promise<void> {
    await holdsParentPay(records);
    return super.saveAll(counters, records);
  }
}

/** Resolves when `held` does, or rejects when the step is aborted. */
const until = (held: Promise<void>, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("the step was stopped"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void held.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
  });

/** A paid step: `costOf(item)` dollars, then — for item `a` on its first step — work until let go. */
function paidStep(name: string, step: string, costOf: (item: string) => number, works = false) {
  @Action({
    name: `${name}-action`,
    description: "Pays a service for the item",
    input: { item: ItemDto },
    output: ItemDto,
    deps: [SpendRecorder, ExecutionContext],
  })
  class PaidStep {
    constructor(
      private readonly spendRecorder: SpendRecorder,
      private readonly executionContext: ExecutionContext,
    ) {}

    async execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<ItemDto> {
      const item = input.item.value;
      inFlight.ran.push(`${item.name}:${step}`);
      inFlight.where.set(
        `${item.name}:${step}`,
        this.executionContext.tenant.application.instanceId,
      );
      this.spendRecorder.record({ service: "pay-api", cost: usd(costOf(item.name)) });
      if (works && item.name === "a") await until(inFlight.working, this.executionContext.signal);
      return item;
    }
  }
  return PaidStep;
}

function doneOf(name: string) {
  @Action({
    name: `${name}-done-action`,
    description: "The item is done",
    input: { item: ItemDto },
    output: ItemResultDto,
  })
  class Done {
    execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<ItemResultDto> {
      return Promise.resolve({ name: input.item.value.name });
    }
  }
  return Done;
}

const itemCost = (first: boolean) => (item: string) => (item === "a" ? (first ? 60 : 0) : 30);

/** One item's child: three paid steps, then done. */
function payItemWorkflowOf(name: string): Class {
  const PayOne = paidStep(`${name}-pay-one`, "pay-one", itemCost(true), true);
  const PayTwo = paidStep(`${name}-pay-two`, "pay-two", itemCost(false));
  const PayThree = paidStep(`${name}-pay-three`, "pay-three", itemCost(false));
  const Done = doneOf(name);
  @WorkflowStart({ name: `${name}-workflow-start`, description: "One item", input: ItemDto })
  class Start {}
  @WorkflowFinish({ name: `${name}-workflow-finish`, description: "Paid", output: ItemResultDto })
  class Finish {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [
      start(Start)
        .returns(ItemDto)
        .toAction(PayOne)
        .returns(ItemDto)
        .toAction(PayTwo)
        .returns(ItemDto)
        .toAction(PayThree)
        .returns(ItemDto)
        .toAction(Done)
        .returns(ItemResultDto)
        .toFinish(Finish),
    ],
  })
  class PayItem {}
  return PayItem;
}

const LocalPayItemWorkflow = payItemWorkflowOf("local-pay-item");
const AnyPayItemWorkflow = payItemWorkflowOf("any-pay-item");

@WorkflowFinish({ name: "items-paid-workflow-finish", description: "Paid", output: ItemResultDto })
export class ItemsPaidWorkflowFinish {}

@WorkflowStart({
  name: "local-pay-items-workflow-start",
  description: "Items",
  input: listOf(ItemDto),
})
export class LocalPayItemsWorkflowStart {}
@WorkflowStart({
  name: "any-pay-items-workflow-start",
  description: "Items",
  input: listOf(ItemDto),
})
export class AnyPayItemsWorkflowStart {}

@Workflow({
  name: "local-pay-items-workflow",
  version: "1.0.0",
  flow: [
    start(LocalPayItemsWorkflowStart)
      .returns(listOf(ItemDto))
      .toParallelWorkflows(LocalPayItemWorkflow, {
        maxItems: 2,
        placement: ChildPlacement.ParentInstance,
      })
      .join()
      .returns(listOf(ItemResultDto))
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class LocalPayItemsWorkflow {}

@Workflow({
  name: "any-pay-items-workflow",
  version: "1.0.0",
  flow: [
    start(AnyPayItemsWorkflowStart)
      .returns(listOf(ItemDto))
      .toParallelWorkflows(AnyPayItemWorkflow, {
        maxItems: 2,
        placement: ChildPlacement.AnyInstance,
      })
      .join()
      .returns(listOf(ItemResultDto))
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class AnyPayItemsWorkflow {}

/** #732: the child, two paid steps of $30 each. */
const ChildOne = paidStep("child-one", "child-one", () => 30);
const ChildTwo = paidStep("child-two", "child-two", () => 30);
const ChildDone = doneOf("child-pay");
@WorkflowStart({ name: "child-pay-workflow-start", description: "One item", input: ItemDto })
class ChildPayWorkflowStart {}
@WorkflowFinish({ name: "child-pay-workflow-finish", description: "Paid", output: ItemResultDto })
class ChildPayWorkflowFinish {}
@Workflow({
  name: "child-pay-workflow",
  version: "1.0.0",
  flow: [
    start(ChildPayWorkflowStart)
      .returns(ItemDto)
      .toAction(ChildOne)
      .returns(ItemDto)
      .toAction(ChildTwo)
      .returns(ItemDto)
      .toAction(ChildDone)
      .returns(ItemResultDto)
      .toFinish(ChildPayWorkflowFinish),
  ],
})
class ChildPayWorkflow {}

const ParentPay = paidStep("parent-pay", "parent-pay", () => 90);
@WorkflowStart({ name: "parent-pay-workflow-start", description: "An item", input: ItemDto })
export class ParentPayWorkflowStart {}
@Workflow({
  name: "parent-pay-workflow",
  version: "1.0.0",
  flow: [
    start(ParentPayWorkflowStart)
      .returns(ItemDto)
      .toAction(ParentPay)
      .returns(ItemDto)
      .toWorkflow(ChildPayWorkflow, { placement: ChildPlacement.AnyInstance })
      .returns(ItemResultDto)
      .toFinish(ItemsPaidWorkflowFinish),
  ],
})
export class ParentPayWorkflow {}

@Application({
  name: "spend-in-flight-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LocalPayItemsWorkflow, AnyPayItemsWorkflow, ParentPayWorkflow],
  budgets: TEST_BUDGETS,
  providers: [HeldParentLedger, WatchedCheckpointSaver],
})
export class SpendInFlightApplication {}

/**
 * The same on two instances sharing the in-memory stores, one step at a time on each
 * (`maxConcurrentSteps: 1`): while item `a` works on one instance, item `b` runs on the other.
 */
@Application({
  name: "spend-in-flight-instances-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [AnyPayItemsWorkflow, ParentPayWorkflow],
  budgets: TEST_BUDGETS,
  maxConcurrentSteps: 1,
  providers: [HeldParentLedger],
})
export class SpendInFlightInstancesApplication {}
