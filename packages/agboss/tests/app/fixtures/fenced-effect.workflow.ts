import { until } from "../../helpers/until.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  Budget,
  BudgetScope,
  ExecutionContext,
  FencedEffectRepository,
  IdempotencyRunStatus,
  InMemoryFencedEffectRepository,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type BudgetHandler,
  type Tracked,
} from "../../../src/index.js";
import { effectKeyOf } from "../../../src/stores/index.js";
import { effectKeyForTesting } from "../../../src/testing/contracts/effect-key.js";
import { onEffectCommit } from "../../../src/infrastructure/in-memory-effect-writes.js";
import { Application } from "../../../src/application/application.js";
import { usd, type Bytes, type Usd } from "../../../src/units/index.js";
import { TestApplicationDailyBudget, TestTenantDailyBudget } from "../../flow/fixtures/budgets.js";
import { onStart, toFinish } from "../../helpers/flow.js";
import { RecoveryLog } from "../../infrastructure/fixtures/recovery.workflow.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";

/**
 * #500 — an order charged through the fenced effect: the charge action writes its charge row in
 * the effect's transaction (the built-in in-memory store, no table of its own) and returns the
 * stored receipt. The test's levers freeze a run before its effect (a zombie in its window) or
 * after it (a crash before the checkpoint), one gate per run, in order.
 */

/** One charge row the action wrote: whom, under which token, its receipt. */
export interface ChargeRow {
  readonly order: string;
  readonly token: number;
  readonly chargeId: string;
}

/** The business rows (shared by the test's instances, one process) and what the runs saw. */
export const book = {
  charges: [] as ChargeRow[],
  /** Each run of the action: the token it ran under and how its effect went (`refused`). */
  runs: [] as { readonly token: number; readonly status: IdempotencyRunStatus | "refused" }[],
  /** What a budget's `maxSpend()` got from `effectKeyOf` (no lease is held there). */
  budgetKey: [] as unknown[],
};

/** How many coming runs freeze before / after their effect, and the gates of the frozen ones. */
export const gates = {
  before: 0,
  after: 0,
  frozen: [] as (() => void)[],
};

/** How many characters pad the next receipts (a result above `maxResultSize`). */
export const charging = { padding: 0, maxResultSize: undefined as Bytes | undefined };

export function resetFencedEffect(): void {
  charging.padding = 0;
  charging.maxResultSize = undefined;
  book.charges.length = 0;
  book.runs.length = 0;
  book.budgetKey.length = 0;
  gates.before = 0;
  gates.after = 0;
  gates.frozen.length = 0;
}

/**
 * Lets every frozen run go, in the order they froze, and disarms the levers (#509): a run that
 * reaches its gate later — after a test failed while it was still on its way — goes through
 * instead of freezing with no one to let it go, which kept the test's apps from closing.
 */
export function letAllGo(): void {
  gates.before = 0;
  gates.after = 0;
  for (const letGo of gates.frozen.splice(0)) letGo();
}

/** Until `count` runs are frozen (each in the background of its instance), in real time (#509). */
export async function frozenRuns(count: number): Promise<void> {
  await until(() => gates.frozen.length >= count, `${String(count)} runs froze`);
}

/** Waits at a gate when the lever says so. */
export async function gate(side: "before" | "after"): Promise<void> {
  if (gates[side] <= 0) return;
  gates[side] -= 1;
  await new Promise<void>((resolve) => {
    gates.frozen.push(resolve);
  });
}

export class ChargeReceiptDto {
  @Text({ prompt: "the charge's id" })
  chargeId!: string;
}

/** The charge's receipt as the effect stores it. */
interface Receipt {
  readonly chargeId: string;
}

@Action({
  name: "charge-order-action",
  description: "Charges the order once, through the fenced effect",
  input: { message: WorkflowStartTextDto },
  output: ChargeReceiptDto,
  deps: [ExecutionContext, InMemoryFencedEffectRepository], // the store the application lists
})
export class ChargeOrderAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffects: InMemoryFencedEffectRepository,
  ) {}

  async execute(input: {
    readonly message: Tracked<WorkflowStartTextDto>;
  }): Promise<ChargeReceiptDto> {
    const made = effectKeyOf(this.executionContext, "charge");
    // the largest result is the key's own (#1317): the lever of a test that pads the receipts
    const key =
      charging.maxResultSize === undefined
        ? made
        : effectKeyForTesting(made, { maxResultSize: charging.maxResultSize });
    await gate("before");
    const order = input.message.text;
    const outcome = await this.fencedEffects
      .runOnce(key, (): Receipt => {
        const chargeId = `charge-${order}-${String(key.token)}${"x".repeat(charging.padding)}`;
        onEffectCommit(() => book.charges.push({ order, token: key.token, chargeId }));
        return { chargeId };
      })
      .catch((error: unknown) => {
        book.runs.push({ token: key.token, status: "refused" });
        throw error;
      });
    book.runs.push({ token: key.token, status: outcome.status });
    await gate("after");
    return { chargeId: outcome.result.chargeId };
  }
}

/**
 * Charges one order twice at once in one step: the second call joins the first. It injects the
 * contract — whatever store the application lists.
 */
@Action({
  name: "double-charge-action",
  description: "Charges the order from two places of one step at once",
  input: { message: WorkflowStartTextDto },
  output: ChargeReceiptDto,
  deps: [ExecutionContext, FencedEffectRepository],
})
export class DoubleChargeAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffects: FencedEffectRepository,
  ) {}

  async execute(input: {
    readonly message: Tracked<WorkflowStartTextDto>;
  }): Promise<ChargeReceiptDto> {
    const key = effectKeyOf(this.executionContext, "charge");
    const order = input.message.text;
    const charge = (): Receipt => {
      onEffectCommit(() => book.charges.push({ order, token: key.token, chargeId: order }));
      return { chargeId: order };
    };
    const outcomes = await Promise.all([
      this.fencedEffects.runOnce(key, charge),
      this.fencedEffects.runOnce(key, charge),
    ]);
    for (const outcome of outcomes) book.runs.push({ token: key.token, status: outcome.status });
    return { chargeId: outcomes[1].result.chargeId };
  }
}

/** The execution budget: it reads the fence's key where no lease is held (before the first pass). */
@Budget({ name: "fenced-execution-budget", scope: BudgetScope.Execution, deps: [ExecutionContext] })
export class FencedExecutionBudget implements BudgetHandler {
  constructor(private readonly executionContext: ExecutionContext) {}

  maxSpend(): Usd {
    try {
      book.budgetKey.push(effectKeyOf(this.executionContext, "budget"));
    } catch (error) {
      book.budgetKey.push(error);
    }
    return usd(100);
  }
}

@WorkflowStart({
  name: "charge-workflow-start",
  description: "An order",
  input: WorkflowStartTextDto,
})
export class ChargeWorkflowStart {}

@WorkflowStart({
  name: "double-charge-workflow-start",
  description: "An order charged twice at once",
  input: WorkflowStartTextDto,
})
export class DoubleChargeWorkflowStart {}

@WorkflowFinish({
  name: "charged-workflow-finish",
  description: "The receipt",
  output: ChargeReceiptDto,
})
export class ChargedWorkflowFinish {}

@WorkflowFinish({
  name: "not-charged-workflow-finish",
  description: "The charge failed",
  output: WorkflowStartTextDto,
})
export class NotChargedWorkflowFinish {}

@Workflow({
  name: "charge-workflow",
  version: "1.0.0",
  flow: [
    onStart(ChargeWorkflowStart)
      .toAction(ChargeOrderAction)
      // a catch-all side path: a business error takes it, a fenced write never does
      .onError(Error, toFinish(NotChargedWorkflowFinish))
      .toFinish(ChargedWorkflowFinish),
  ],
})
export class ChargeWorkflow {}

@WorkflowFinish({
  name: "double-charged-workflow-finish",
  description: "The receipt",
  output: ChargeReceiptDto,
})
export class DoubleChargedWorkflowFinish {}

/** Its one action injects the contract: it runs on whatever fenced-effect store is the application's. */
@Workflow({
  name: "double-charge-workflow",
  version: "1.0.0",
  flow: [
    onStart(DoubleChargeWorkflowStart)
      .toAction(DoubleChargeAction)
      .toFinish(DoubleChargedWorkflowFinish),
  ],
})
export class DoubleChargeWorkflow {}

@Application({
  name: "fenced-effect-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  workflows: [ChargeWorkflow, DoubleChargeWorkflow],
  observers: [RecoveryLog],
  budgets: [TestApplicationDailyBudget, TestTenantDailyBudget, FencedExecutionBudget],
  providers: [InMemoryFencedEffectRepository],
})
export class FencedEffectApplication {}
