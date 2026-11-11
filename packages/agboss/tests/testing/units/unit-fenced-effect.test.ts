/**
 * #500 — the fenced effect in a unit runner: `testAction` / `testTool` give the component the
 * built-in in-memory store on the runner's held lease (token 1, or the `fence` option's), so a
 * step's effect runs, replays on a second call of one runner, and is refused once the lease is lost
 * or past its confirmation.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { StoreDescriptor } from "../../../src/index.js";
import { WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  Clock,
  StoreClock,
  ExecutionContext,
  ExecutionFencedError,
  ExecutionLeaseRepository,
  FencedEffectSettings,
  FencedEffectStatus,
  effectKeyOf,
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

/** A project's store that declares no backend: the runner has no lease store to hold its lease in. */
@Injectable({
  deps: [StoreClock, IN_MEMORY_DATABASE, FencedEffectSettings, ExecutionLeaseRepository],
})
class UnleasedFencedEffectRepository extends InMemoryFencedEffectRepository {
  static override readonly store: StoreDescriptor = { backend: undefined };
}

/** A project's store on a backend the runner has no lease store of, and the test lists none. */
@Injectable({
  deps: [StoreClock, IN_MEMORY_DATABASE, FencedEffectSettings, ExecutionLeaseRepository],
})
class MisdeclaredFencedEffectRepository extends InMemoryFencedEffectRepository {
  static override readonly store: StoreDescriptor = { backend: "postgres" };
}

/** A project's own store on the in-memory backend: the runner finds its lease store by it (#825). */
@Injectable({
  deps: [StoreClock, IN_MEMORY_DATABASE, FencedEffectSettings, ExecutionLeaseRepository],
})
class OwnInMemoryFencedEffectRepository extends InMemoryFencedEffectRepository {
  static override readonly store: StoreDescriptor = { backend: "in-memory" };
}

const writeOnce = (store: InMemoryFencedEffectRepository, executionContext: ExecutionContext) =>
  store.runOnce(effectKeyOf(executionContext, "charge"), () => "done");

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

@Action({
  name: "own-store-charge-action",
  description: "Charges through a project's own in-memory store",
  input: { message: WorkflowStartTextDto },
  deps: [ExecutionContext, OwnInMemoryFencedEffectRepository],
})
class OwnStoreChargeAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly store: OwnInMemoryFencedEffectRepository,
  ) {}

  async execute(): Promise<void> {
    await writeOnce(this.store, this.executionContext);
  }
}

describe("#825: the runner finds a store's lease store by its backend", () => {
  it("a project's store on the in-memory backend: its lease held there, its effect runs", async () => {
    const run = testAction(OwnStoreChargeAction);

    await expect(run(order)).resolves.toMatchObject({ output: undefined });
  });
});

describe("#500: a store whose lease store the runner cannot find", () => {
  it.each([
    ["declares no backend", UnleasedChargeAction],
    ["is on a backend of no lease store the runner has", MisdeclaredChargeAction],
  ])("%s: the runner holds no lease for it, so its effect is refused", async (_case, action) => {
    const run = testAction(action);

    await expect(run(order)).rejects.toBeInstanceOf(ExecutionFencedError);
  });
});
