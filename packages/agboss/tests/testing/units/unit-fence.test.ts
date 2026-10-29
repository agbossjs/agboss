/**
 * #471 AC5 — the fence of a unit test's step: `testAction` / `testTool` (any unit runner) and
 * `testExecutionContext()` give a held lease by default — token 1, the execution's own scope, the
 * tenant given, confirmed for 30 s on the runner's clock — and the `fence` option sets each field
 * or makes its checks refuse (`isLost`, `confirmNowFails`).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ExecutionFencedError, ExecutionLeaseLostError } from "../../../src/index.js";
import {
  testAction,
  testExecutionContext,
  testTool,
  VirtualClock,
} from "../../../src/testing/index.js";
import { testFenceLeaseOf } from "../../../src/testing/fence.js";
import { seconds } from "../../../src/units/index.js";
import {
  ArtifactLedger,
  ledger,
  levers,
  ReleaseAction,
  resetFence,
  seen,
  Staged,
  StageTool,
} from "../../app/fixtures/fence.workflow.js";

beforeEach(resetFence);

const message = { message: { value: { text: "v1" } } } as never;

describe("#471 AC5: a unit runner's fence", () => {
  it("is held by default: token 1, the execution's scope of the default tenant", async () => {
    const run = testAction(ReleaseAction);

    const { output } = await run(message);

    expect(output).toEqual({ text: Staged.Written });
    expect(seen.fences).toEqual([
      {
        scopeKey: "default:test-execution",
        tenantId: "default",
        leaseExecutionId: "test-execution",
        token: 1,
        idempotencyKey: "test-execution:release-action:1",
      },
    ]);
  });

  it("takes the tenant given, and the token and lease execution of its option", async () => {
    const run = testTool(StageTool, {
      tenant: { tenantId: "acme:eu" },
      fence: { token: 7, leaseExecutionId: "root:1" },
    });

    await run({ artifact: "v1" });

    expect(seen.fences[0]).toMatchObject({
      scopeKey: "acme%3Aeu:root%3A1",
      tenantId: "acme:eu",
      leaseExecutionId: "root:1",
      token: 7,
    });
    expect(ledger.rows.map((row) => row.token)).toEqual([7]);
  });

  it("isLost: assertHeld() throws ExecutionLeaseLostError, nothing is written", async () => {
    const run = testAction(ReleaseAction, { fence: { isLost: true } });

    await expect(run(message)).rejects.toThrow(ExecutionLeaseLostError);
    expect(ledger.rows).toEqual([]);
  });

  it("confirmNowFails: only confirmNow() rejects — the write is in, the webhook is not called", async () => {
    levers.confirmFirst = true;
    const lost = testAction(ReleaseAction, { fence: { confirmNowFails: true } });
    const failed = testAction(ReleaseAction, {
      fence: { confirmNowFails: new Error("store down") },
    });

    await expect(lost(message)).rejects.toThrow(ExecutionLeaseLostError);
    await expect(failed(message)).rejects.toThrow("store down");

    expect(ledger.rows).toHaveLength(1);
    expect(seen.notified).toEqual([]);
  });

  it("confirmNow() resolves by default: the step goes on to its webhook", async () => {
    levers.confirmFirst = true;

    await testAction(ReleaseAction)(message);

    expect(seen.notified).toEqual(["test-execution:release-action:1"]);
  });

  it("a refused write is the step's ExecutionFencedError, as in an execution", async () => {
    ledger.highest.set("default:test-execution", 2);

    await expect(testAction(ReleaseAction)(message)).rejects.toThrow(ExecutionFencedError);
    expect(ledger.refused).toEqual([{ scopeKey: "default:test-execution", token: 1 }]);
  });
});

describe("#471 AC5: testExecutionContext()'s fence", () => {
  it("confirmedUntil is its clock + 30 s; assertHeld() refuses from then on", async () => {
    const clock = new VirtualClock();
    const context = testExecutionContext({ clock, tenant: { tenantId: "acme" } });

    expect(context.fence.scopeKey).toBe("acme:test-execution");
    expect(context.fence.token).toBe(1);
    expect(context.fence.confirmedUntil).toEqual(new Date(clock.now().getTime() + seconds(30)));
    context.fence.assertHeld();
    await clock.advance(seconds(30));
    expect(() => {
      context.fence.assertHeld();
    }).toThrow(ExecutionLeaseLostError);
  });

  it("each field of the option, and fenced() building the error for its scope", () => {
    const confirmedUntil = new Date("2026-02-01T00:00:00.000Z");
    const { fence } = testExecutionContext({
      executionId: "execution-9",
      fence: { token: 3, leaseExecutionId: "root-9", confirmedUntil },
    });

    expect(fence).toMatchObject({ scopeKey: "default:root-9", token: 3, confirmedUntil });
    expect(fence.fenced(4)).toMatchObject({
      scopeKey: "default:root-9",
      token: 3,
      observedToken: 4,
    });
    expect(fence.fenced()).toBeInstanceOf(ExecutionFencedError);
  });

  it("isLost: confirmNow() rejects too, and the confirmNowFails option does not matter", async () => {
    const { fence } = testExecutionContext({
      fence: { isLost: true, confirmNowFails: new Error("store down") },
    });

    await expect(fence.confirmNow()).rejects.toThrow(ExecutionLeaseLostError);
    expect(() => {
      fence.assertHeld();
    }).toThrow(ExecutionLeaseLostError);
  });

  it("the lost error names the execution the lease is of", async () => {
    const { fence } = testExecutionContext({
      executionId: "execution-9",
      fence: { leaseExecutionId: "root-9", isLost: true },
    });

    await expect(fence.confirmNow()).rejects.toMatchObject({ rootExecutionId: "root-9" });
  });

  it("a unit test's lease is never yielded: entering a step holds it, leaving changes nothing", async () => {
    const lease = testFenceLeaseOf(
      { token: 2 },
      { tenantId: "acme", executionId: "execution-1", clock: new VirtualClock() },
    );

    const leave = await lease.enterStep();
    leave();
    leave();

    expect(lease).toMatchObject({ isYielded: false, token: 2, scopeKey: "acme:execution-1" });
    expect(Object.isFrozen(lease)).toBe(true);
  });

  it("a class created by hand fences with it", async () => {
    const action = new ReleaseAction(testExecutionContext(), new ArtifactLedger());

    const receipt = await action.execute(message);

    expect(receipt).toEqual({ text: Staged.Written });
    expect(seen.fences[0]?.token).toBe(1);
  });
});
