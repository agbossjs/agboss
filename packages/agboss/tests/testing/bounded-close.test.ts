/**
 * #509 (the second flake): `fenced-effect-sqlite.test.ts` hung CI for 40 minutes. Its fixture waited
 * a count of event-loop turns for a run to freeze at a gate; on a loaded machine the cold first run
 * got there later, the test failed, `afterEach` let nothing go, the run then froze at the still-armed
 * gate, and the teardown's `app.close()` waited for it — its shutdown timeout on a `VirtualClock`
 * nobody advances, in a fixture teardown vitest never bounds. The fixes: waits in real time
 * (`until`), gates disarmed when let go, and every test app's close bounded in real time.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CLOSE_TIMEOUT, closedWithin } from "../../src/testing/bounded-close.js";
import { TestEnvironment } from "../../src/testing/environment.js";
import { AppCloseTimeoutError } from "../../src/testing/errors.js";
import { createTestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import {
  ChargeWorkflowStart,
  FencedEffectApplication,
  frozenRuns,
  gate,
  gates,
  letAllGo,
  resetFencedEffect,
} from "../app/fixtures/fenced-effect.workflow.js";
import { execute } from "../helpers/flow.js";
import { NotReachedError, until } from "../helpers/until.js";

const NEVER = new Promise<never>(() => undefined);

afterEach(() => {
  letAllGo();
  resetFencedEffect();
});

describe("#509: a test app's close is bounded in real time", () => {
  it("a close that ends is awaited as it is", async () => {
    await expect(closedWithin(Promise.resolve(), 1, seconds(1))).resolves.toBeUndefined();
    expect(CLOSE_TIMEOUT).toBe(seconds(10));
  });

  it("a close that never ends → AppCloseTimeoutError naming the instance, never a hung run", async () => {
    const closing = closedWithin(NEVER, 2, seconds(0.05));

    await expect(closing).rejects.toBeInstanceOf(AppCloseTimeoutError);
    await expect(closedWithin(NEVER, 2, seconds(0.05))).rejects.toMatchObject({
      code: "test.close-timeout",
      message: expect.stringContaining("instance 2 of the test's application did not close"),
    });
  });

  it("a close that fails keeps its own error", async () => {
    const failing = closedWithin(Promise.reject(new Error("onDestroy failed")), 1, seconds(1));

    await expect(failing).rejects.toThrow("onDestroy failed");
  });

  it("a run frozen at a gate no one lets go fails the teardown fast, then closes once let go", async () => {
    const environment = await TestEnvironment.of(FencedEffectApplication);
    const app = createTestApp(environment);
    gates.after = 1;
    const call = execute(app, ChargeWorkflowStart, { text: "order-7" });
    await frozenRuns(1);

    await expect(environment.close(seconds(0.2))).rejects.toBeInstanceOf(AppCloseTimeoutError);

    letAllGo();
    await call;
    await expect(environment.close()).resolves.toBeUndefined();
  });
});

describe("#509: the fixture's waits and gates", () => {
  it("letAllGo disarms the levers: a run reaching its gate later goes through", async () => {
    gates.before = 1;
    gates.after = 1;

    letAllGo();

    await expect(gate("before")).resolves.toBeUndefined();
    await expect(gate("after")).resolves.toBeUndefined();
    expect(gates.frozen).toEqual([]);
  });

  it("until waits turn by turn for the condition, in real time", async () => {
    let turns = 0;

    await until(() => (turns += 1) > 3_000, "3000 turns");

    expect(turns).toBe(3_001);
  });

  it("until gives up after its timeout, naming what it waited for", async () => {
    await expect(until(() => false, "the run froze", 30)).rejects.toThrow(
      new NotReachedError("the run froze within 30 ms of real time"),
    );
  });
});
