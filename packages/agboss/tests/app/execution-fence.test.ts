/**
 * #471 — `executionContext.fence`: the lease a step runs under, as an external system fences a
 * write with it. A write of an instance that lost the lease meets a newer token and is refused
 * (`ExecutionFencedError`), which is a hand-over — no `.onError`, no compensation, no failed record,
 * no `onExecutionError` — and the moving call rejects with the fenced error itself.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import {
  ExecutionContextUnavailableError,
  ExecutionFencedError,
  ExecutionLeaseLostError,
  ResumeReason,
} from "../../src/index.js";
import {
  callTool,
  replyWith,
  testWith,
  type TestLeases,
  type VirtualClock,
} from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import {
  ends,
  resetRecovery,
  seen as recovery,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { instance, rejectionOf, settle, takenOver } from "./fixtures/fence-takeover.js";
import {
  AgentReleaseWorkflowStart,
  ApprovedStageTool,
  BookedReleaseWorkflowStart,
  FenceApplication,
  frozenRelease,
  ledger,
  levers,
  ReleaseAgent,
  ReleaseWorkflowStart,
  ReceiptDto,
  resetFence,
  seen,
  Staged,
  StageTool,
} from "./fixtures/fence.workflow.js";

const test = testWith(FenceApplication);
const two = testWith(FenceApplication, { instances: 2 });

beforeEach(() => {
  resetFence();
  resetRecovery();
});

// a frozen release is let go whatever the test did: its app closes on the virtual clock
afterEach(() => {
  levers.letGo?.();
});

describe("#471 AC1: the fence of a step", () => {
  test("an action reads the root's lease: its scope, tenant and token 1", async ({ app }) => {
    const result = await execute(
      app,
      ReleaseWorkflowStart,
      { text: "v1" },
      { tenant: { tenantId: "acme" } },
    );

    expect(result.output).toEqual({ text: Staged.Written });
    expect(seen.fences).toEqual([
      {
        scopeKey: `acme:${result.executionId}`,
        tenantId: "acme",
        leaseExecutionId: result.executionId,
        token: 1,
        idempotencyKey: `${result.executionId}:release-action:1`,
      },
    ]);
  });

  test("a tool call in an agent's loop reads the same lease, with its call's key", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ReleaseAgent).thenReturn(
      callTool(StageTool, { artifact: "v1" }),
      replyWith(ReceiptDto, { text: "staged" }),
    );

    const result = await execute(app, AgentReleaseWorkflowStart, { text: "stage v1" });

    expect(result.output).toEqual({ text: "staged" });
    expect(seen.fences).toHaveLength(1);
    expect(seen.fences[0]).toMatchObject({
      scopeKey: `default:${result.executionId}`,
      leaseExecutionId: result.executionId,
      token: 1,
    });
    expect(seen.fences[0]?.idempotencyKey).toMatch(
      new RegExp(`^${result.executionId}:release-agent:1:`),
    );
  });
});

describe("#471 AC3: a stalled writer is refused after another instance took the lease over", () => {
  two(
    "A passes assertHeld(), stalls in the window, B takes the lease (token 2) and writes; A's write is refused: its call rejects with the ExecutionFencedError",
    async ({ apps, clock, leases }) => {
      const { call } = await takenOver(apps, clock, leases);
      expect(seen.fences.map((each) => each.token)).toEqual([1, 2]);
      expect(recovery.ends.map((end) => end.output)).toEqual([{ text: Staged.Written }]);

      // the process wakes: its step writes before its held lease timers fire
      levers.letGo?.();
      await settle();
      leases.resume(instance(apps, 0));
      await settle();
      const error = await rejectionOf(call);

      expect(error).toBeInstanceOf(ExecutionFencedError);
      expect(error).toMatchObject({ token: 1, observedToken: 2 });
      expect(ledger.rows).toHaveLength(1);
      expect(ledger.rows[0]?.token).toBe(2);
      expect(ledger.refused).toEqual([{ scopeKey: seen.fences[0]?.scopeKey, token: 1 }]);
      expect(recovery.resumes).toEqual([{ reason: ResumeReason.Recovered, decision: undefined }]);
      expect(recovery.errors).toEqual([]);
    },
  );

  two(
    "its held timers fire first: the lease expires here, the call rejects as a lost lease and the late write is still refused",
    async ({ apps, clock, leases }) => {
      const { call } = await takenOver(apps, clock, leases);

      leases.resume(instance(apps, 0));
      await settle();
      levers.letGo?.();
      const error = await rejectionOf(call);
      await settle();

      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect(ledger.rows.map((row) => row.token)).toEqual([2]);
      expect(ledger.refused.map((row) => row.token)).toEqual([1]);
      expect(recovery.errors).toEqual([]);
    },
  );
});

describe("#471 AC6: a fenced error is a hand-over wherever it is found", () => {
  for (const wrap of ["bare", "cause", "aggregate", "cycle"] as const) {
    test(`fenced (${wrap}): the call rejects with the ExecutionFencedError itself, no onExecutionError`, async ({
      app,
    }) => {
      levers.wrap = wrap;

      const error: unknown = await execute(app, ReleaseWorkflowStart, { text: "v1" }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(ExecutionFencedError);
      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect(error).toMatchObject({ token: 1, observedToken: 2 });
      expect(recovery.errors).toEqual([]);
      expect(recovery.ends).toEqual([]);
    });
  }
});

describe("#471 AC6: a fenced error inside an agent's loop and in an undo", () => {
  test("a fenced tool call ends the loop: no onToolEnd, the model reads nothing, the call rejects with it", async ({
    app,
    mockLlm,
  }) => {
    levers.wrap = "cause";
    mockLlm(ReleaseAgent).thenReturn(callTool(StageTool, { artifact: "v1" }));

    const error = await rejectionOf(execute(app, AgentReleaseWorkflowStart, { text: "stage v1" }));

    expect(error).toBeInstanceOf(ExecutionFencedError);
    expect(seen.toolEnds).toEqual([]);
    expect(mockLlm(ReleaseAgent)).toHaveBeenCalledTimes(1);
    expect(recovery.errors).toEqual([]);
  });

  test("a fenced tool interceptor is a hand-over, never the interceptor's failure", async ({
    app,
    mockLlm,
  }) => {
    levers.isInterceptorFenced = true;
    mockLlm(ReleaseAgent).thenReturn(callTool(StageTool, { artifact: "v1" }));

    const error = await rejectionOf(execute(app, AgentReleaseWorkflowStart, { text: "stage v1" }));

    expect(error).toBeInstanceOf(ExecutionFencedError);
    expect(seen.fences).toEqual([]);
    expect(seen.toolEnds).toEqual([]);
    expect(recovery.errors).toEqual([]);
  });

  test("an undo fenced while the failed tree unwinds is a hand-over: no CompensationFailedError, no onExecutionError", async ({
    app,
  }) => {
    levers.isUndoFenced = true;

    const error = await rejectionOf(execute(app, BookedReleaseWorkflowStart, { text: "v1" }));

    expect(error).toBeInstanceOf(ExecutionFencedError);
    expect(seen.undone).toEqual([]);
    expect(recovery.errors).toEqual([]);
  });

  test("an undo outside a visit fences with the tree's lease (#340 PR 3)", async ({ app }) => {
    const result = await rejectionOf(execute(app, BookedReleaseWorkflowStart, { text: "v1" }));

    expect(result).toMatchObject({
      name: "ActionFailedError",
      cause: { name: "ReleaseRefusedError" },
    });
    expect(seen.undone).toHaveLength(1);
    expect(seen.undone[0]).toMatchObject({ token: 1 });
    expect(seen.undone[0]?.idempotencyKey).toMatch(/:book-action:1:compensation$/);
    expect(recovery.errors).toHaveLength(1);
  });

  test("a business error still takes .onError(Error, …): only a fenced write is a hand-over", async ({
    app,
  }) => {
    levers.isRefused = true;

    const result = await execute(app, ReleaseWorkflowStart, { text: "v1" });

    expect(result.finish).toMatchObject({ name: "not-released-workflow-finish" });
    expect(result.output).toEqual({ text: "v1" });
    expect(recovery.errors).toEqual([]);
  });
});

describe("#471 AC4: the token across passes; a replayed write is deduplicated", () => {
  test("a pause and its resume: the step after the resume fences with token 2, and its write passes", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ReleaseAgent).thenReturn(
      callTool(ApprovedStageTool, { artifact: "v1" }),
      replyWith(ReceiptDto, { text: "staged" }),
    );
    const paused = await execute(app, AgentReleaseWorkflowStart, { text: "stage v1" });
    expect(seen.fences).toEqual([]);

    const result = await app.resume(answerOf(paused, { approved: true }));

    expect(result.output).toEqual({ text: "staged" });
    expect(seen.fences.map((each) => each.token)).toEqual([2]);
    expect(ledger.rows.map((row) => row.token)).toEqual([2]);
  });

  two(
    "a crash after the write: the recovered step replays it under token 2, deduplicated by its key",
    async ({ apps, clock, leases }) => {
      levers.freezeAfterWrite = true;
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      const frozen = frozenRelease();
      const call = execute(a, ReleaseWorkflowStart, { text: "v1" });
      call.catch(() => undefined);
      await frozen;
      leases.stall(a);

      await clock.advance(seconds(31));
      await clock.advance(seconds(31));
      const [recovered] = await ends(1);

      expect(recovered?.output).toEqual({ text: Staged.Deduplicated });
      expect(seen.fences.map((each) => each.token)).toEqual([1, 2]);
      expect(seen.fences[0]?.idempotencyKey).toBe(seen.fences[1]?.idempotencyKey);
      expect(ledger.rows.map((row) => row.token)).toEqual([1]);
      expect(ledger.highest.get(seen.fences[0]?.scopeKey ?? "")).toBe(2);
      leases.resume(a);
      levers.letGo?.();
      await expect(call).rejects.toThrow(ExecutionLeaseLostError);
    },
  );
});

describe("#471 AC1: a fence read where its step is gone", () => {
  test("a fence kept past its step refuses: it never reads another frame's lease", async ({
    app,
  }) => {
    await execute(app, ReleaseWorkflowStart, { text: "v1" });
    const [kept] = seen.kept;

    expect(() => kept?.token).toThrow(ExecutionContextUnavailableError);
    expect(() => kept?.assertHeld()).toThrow(ExecutionContextUnavailableError);
    await expect(kept?.confirmNow()).rejects.toThrow(ExecutionContextUnavailableError);
  });

  test("a tool called on its own (a test slice) has no fence", async ({ app }) => {
    const output = await app.tool(StageTool).invoke({ artifact: "v1" });

    expect(output).toMatchObject({ kind: "error" });
    expect(JSON.stringify(output)).toMatch(/context|lease/);
    expect(ledger.rows).toEqual([]);
  });
});
