/**
 * #890 AC2 — the app-facing service of the fenced effect: `FencedEffects.runOnce(key, work)` over
 * the listed `FencedEffectRepository`, injected without being listed (a core service, as
 * `OutboundCalls`), so business code never names a store; the store's own verb is `runOnce` too.
 * Through an application on SQLite: tests/app/fenced-effect-sqlite.test.ts (its action injects
 * `FencedEffects<DatabaseSync>`).
 */
import { describe, expect, it } from "vitest";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import {
  Action,
  ExecutionContext,
  FencedEffectRepository,
  FencedEffects,
  FencedEffectSettings,
  ExecutionLeaseRepository,
  InMemoryFencedEffectRepository,
  Injectable,
  StoreClock,
  effectKeyOf,
  type EffectKey,
  type FencedEffectOutcome,
  type FencedEffectWork,
  type Produced,
} from "../../src/index.js";
import { override, testAction } from "../../src/testing/index.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/in-memory-database.js";
import { FENCED_EFFECTS_OUTSIDE_APPLICATION } from "../../src/app/fenced-effects.js";
import { lifecycleOf } from "../../src/app/workflow-lifecycle.js";
import type { InMemoryFencedEffectTransaction } from "../../src/stores/index.js";
import { ChargeReceiptDto } from "./fixtures/fenced-effect.workflow.js";

/** How often each order's work ran. */
const worked: string[] = [];

/** The keys a test's replacement of the in-memory store was called with. */
const replaced: string[] = [];

/** A test's replacement of the listed store, by its own class (`override(Store, …)`). */
@Injectable({
  deps: [StoreClock, IN_MEMORY_DATABASE, FencedEffectSettings, ExecutionLeaseRepository],
})
class RecordingFencedEffectRepository extends InMemoryFencedEffectRepository {
  override runOnce<TResult>(
    key: EffectKey,
    work: FencedEffectWork<InMemoryFencedEffectTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    replaced.push(key.name);
    return super.runOnce(key, work);
  }
}

@Action({
  name: "fenced-receipt-action",
  description: "Gives the order's receipt once, through the application's fenced effects",
  input: { message: WorkflowStartTextDto },
  output: ChargeReceiptDto,
  deps: [ExecutionContext, FencedEffects],
})
class FencedReceiptAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffects: FencedEffects,
  ) {}

  async execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<ChargeReceiptDto> {
    const order = input.message.value.text;
    const { result } = await this.fencedEffects.runOnce(
      effectKeyOf(this.executionContext, "receipt"),
      () => {
        worked.push(order);
        return { chargeId: `receipt-${order}` };
      },
    );
    return result;
  }
}

describe("#890 AC2: FencedEffects.runOnce, the service an application injects", () => {
  const order = { message: { value: { text: "order-1" } } } as never;

  it("AC2: runs the work once per key on the store the container gives, then replays its result", async () => {
    const run = testAction(FencedReceiptAction);
    worked.length = 0;

    const first = await run(order);
    const second = await run(order);

    expect([first.output, second.output]).toEqual([
      { chargeId: "receipt-order-1" },
      { chargeId: "receipt-order-1" },
    ]);
    expect(worked).toEqual(["order-1"]);
  });

  it("AC2: the store's verb is runOnce; saveResultIfAbsent is gone", () => {
    expect(typeof FencedEffectRepository.prototype.runOnce).toBe("function");
    expect("saveResultIfAbsent" in FencedEffectRepository.prototype).toBe(false);
  });

  it("AC2: outside an application's container (agboss check builds, never runs) every call is refused", async () => {
    await expect(FENCED_EFFECTS_OUTSIDE_APPLICATION.runOnce()).rejects.toThrow(
      /a fenced effect runs in an application/u,
    );
  });
});

describe("#890 AC2: a workflow on its own (eval, replay, Studio) runs FencedEffects on its infrastructure", () => {
  const fencedEffects = { store: "the infrastructure's" };
  const infrastructure = { fencedEffects } as never;

  it("AC2: no application's container: the fenced-effect store is the infrastructure's, a test's override over it", () => {
    const own = lifecycleOf(undefined, infrastructure).options.overrides;
    const overridden = lifecycleOf(
      { overrides: new Map([[FencedEffectRepository, "the test's"]]) },
      infrastructure,
    ).options.overrides;

    expect(own?.get(FencedEffectRepository)).toBe(fencedEffects);
    expect(overridden?.get(FencedEffectRepository)).toBe("the test's");
  });

  it("AC2: inside an application's container nothing is added: the application's store is found as listed", () => {
    const application = {} as never;

    expect(lifecycleOf({ application }, infrastructure).options.overrides).toBeUndefined();
  });
});

describe("#890 AC2: a test's replacement of the listed store reaches FencedEffects", () => {
  it("AC2: override(InMemoryFencedEffectRepository, …) is what FencedEffects runs on", async () => {
    replaced.length = 0;
    const run = testAction(FencedReceiptAction, {
      overrides: [override(InMemoryFencedEffectRepository, RecordingFencedEffectRepository)],
    });

    await run({ message: { value: { text: "order-2" } } } as never);

    expect(replaced).toEqual(["receipt"]);
  });
});
