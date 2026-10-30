/**
 * #500 — the fenced effect in a unit runner: `testAction` / `testTool` give the component the
 * built-in in-memory store on the runner's held lease (token 1, or the `fence` option's), so a
 * step's effect runs, replays on a second call of one runner, and is refused once the lease is lost
 * or past its confirmation.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Class } from "../../../src/components/injection.js";
import { WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  Clock,
  ExecutionContext,
  ExecutionFencedError,
  ExecutionLeaseRepository,
  FencedEffectSettings,
  FencedEffectStatus,
  fencedEffectKeyOf,
  InMemoryFencedEffectRepository,
  Injectable,
} from "../../../src/index.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/in-memory-database.js";
import { testAction } from "../../../src/testing/index.js";
import { seconds } from "../../../src/units/index.js";
import {
  book,
  ChargeOrderAction,
  resetFencedEffect,
} from "../../app/fixtures/fenced-effect.workflow.js";

beforeEach(resetFencedEffect);

const order = { message: { value: { text: "order-1" } } } as never;

describe("#500: a unit runner's fenced effect", () => {
  it("runs on the runner's held lease (token 1), then replays the receipt on the same step", async () => {
    const run = testAction(ChargeOrderAction);

    const first = await run(order);
    const second = await run(order);

    expect(first.output).toEqual({ chargeId: "charge-order-1-1" });
    expect(second.output).toEqual(first.output);
    expect(book.runs.map((each) => each.status)).toEqual([
      FencedEffectStatus.Ran,
      FencedEffectStatus.Replayed,
    ]);
    expect(book.charges).toHaveLength(1);
  });

  it("runs under the fence option's token", async () => {
    const run = testAction(ChargeOrderAction, { fence: { token: 4 } });

    const { output } = await run(order);

    expect(output).toEqual({ chargeId: "charge-order-1-4" });
    expect(book.charges).toEqual([{ order: "order-1", token: 4, chargeId: "charge-order-1-4" }]);
  });

  it("a lost lease (isLost) refuses the effect: nothing charged", async () => {
    const run = testAction(ChargeOrderAction, { fence: { isLost: true } });

    await expect(run(order)).rejects.toBeInstanceOf(ExecutionFencedError);
    expect(book.charges).toEqual([]);
  });

  it("past the lease's confirmation on the runner's clock the effect is refused", async () => {
    const run = testAction(ChargeOrderAction);
    await run.clock.advance(seconds(30));

    await expect(run(order)).rejects.toBeInstanceOf(ExecutionFencedError);
    expect(book.charges).toEqual([]);
  });
});

/** A project's store that names no lease store: the runner has nowhere to hold its lease. */
@Injectable({ deps: [Clock, IN_MEMORY_DATABASE, FencedEffectSettings, ExecutionLeaseRepository] })
class UnleasedFencedEffectRepository extends InMemoryFencedEffectRepository {
  static override readonly leaseRepository: Class | undefined = undefined;
}

/** A service that is no lease store. */
@Injectable()
class NotALeaseStore {}

/** A project's store that names a class that is no lease store. */
@Injectable({ deps: [Clock, IN_MEMORY_DATABASE, FencedEffectSettings, ExecutionLeaseRepository] })
class MisdeclaredFencedEffectRepository extends InMemoryFencedEffectRepository {
  static override readonly leaseRepository: Class | undefined = NotALeaseStore;
}

const writeOnce = (store: InMemoryFencedEffectRepository, executionContext: ExecutionContext) =>
  store.saveResultIfAbsent(fencedEffectKeyOf(executionContext, "charge"), () => "done");

@Action({
  name: "unleased-charge-action",
  description: "Charges through a store that names no lease store",
  input: { message: WorkflowStartTextDto },
  deps: [ExecutionContext, UnleasedFencedEffectRepository],
})
class UnleasedChargeAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly store: UnleasedFencedEffectRepository,
  ) {}

  async execute(): Promise<void> {
    await writeOnce(this.store, this.executionContext);
  }
}

@Action({
  name: "misdeclared-charge-action",
  description: "Charges through a store that names no lease store class",
  input: { message: WorkflowStartTextDto },
  deps: [ExecutionContext, MisdeclaredFencedEffectRepository],
})
class MisdeclaredChargeAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly store: MisdeclaredFencedEffectRepository,
  ) {}

  async execute(): Promise<void> {
    await writeOnce(this.store, this.executionContext);
  }
}

describe("#500: a store whose lease store the runner cannot find", () => {
  it.each([
    ["names none", UnleasedChargeAction],
    ["names a class that is no lease store", MisdeclaredChargeAction],
  ])("%s: the runner holds no lease for it, so its effect is refused", async (_case, action) => {
    const run = testAction(action);

    await expect(run(order)).rejects.toBeInstanceOf(ExecutionFencedError);
  });
});
