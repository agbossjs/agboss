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
  effectKeyOf,
  type Produced,
} from "../../src/index.js";
import { testAction } from "../../src/testing/index.js";
import { FENCED_EFFECTS_OUTSIDE_APPLICATION } from "../../src/app/fenced-effects.js";
import { ChargeReceiptDto } from "./fixtures/fenced-effect.workflow.js";

/** How often each order's work ran. */
const worked: string[] = [];

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
