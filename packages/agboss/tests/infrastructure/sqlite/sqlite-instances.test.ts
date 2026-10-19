/**
 * #265 PR 3 — two application instances on one SQLite file (two connections): a root left
 * `running` by an instance that died is continued by the other from its last checkpoint, only the
 * interrupted step running again (M2, automated); a pause made on one instance is resumed on the
 * other; a pause survives a restart of the only instance. Every store is a SQLite implementation.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { ExecutionLeaseLostError, ExecutionStatus, ResumeReason } from "../../../src/index.js";
import { callTool, replyWith, testWith } from "../../../src/testing/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { seconds } from "../../../src/units/index.js";
import { execute, answerOf } from "../../helpers/flow.js";
import {
  Charge,
  Clerk,
  ends,
  Hold,
  kill,
  levers,
  OrderWorkflowStart,
  ReceiptDto,
  resetRecovery,
  seen,
  Step,
} from "../fixtures/recovery.workflow.js";
import { SqliteRecoveryApplication, sqliteFilePerTest } from "./fixtures/sqlite.workflow.js";

sqliteFilePerTest();
const test = testWith(SqliteRecoveryApplication, { instances: 2 });
const single = testWith(SqliteRecoveryApplication);
const approve = { approved: true };

beforeEach(resetRecovery);
afterEach(() => {
  vi.restoreAllMocks();
});

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

/** Starts an execution on `app` that takes a step and then holds; resolves once it holds. */
async function holding(app: TestApp): Promise<{ readonly call: Promise<unknown> }> {
  const held = new Promise<void>((resolve) => {
    levers.holdStarted = resolve;
  });
  const call = execute(app, OrderWorkflowStart, { text: "step, then hold" });
  call.catch(() => undefined);
  await held;
  return { call };
}

describe("#265 M2 (automated): recovery on SQLite after an instance died", () => {
  test("the other instance continues the root from its last checkpoint; only the interrupted step runs again", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Step, { text: "one" }),
      callTool(Hold, { text: "a long job" }),
      replyWith(ReceiptDto, { text: "Done." }),
    );
    for (const app of apps) await app.ready();
    const dying = await holding(instance(apps, 0));

    kill("instance-1");
    await clock.advance(seconds(31));
    const [recovered] = await ends(1);

    await expect(dying.call).rejects.toBeInstanceOf(ExecutionLeaseLostError);
    expect(recovered?.output).toEqual({ text: "Done." });
    expect(seen.steps).toEqual(["one"]);
    expect(seen.holds).toHaveLength(2);
    expect(seen.resumes).toEqual([{ reason: ResumeReason.Recovered, decision: undefined }]);
    expect(seen.leases.map((lease) => [lease.holderInstanceId, lease.leaseEpoch])).toEqual([
      ["instance-1", 1],
      ["instance-2", 2],
    ]);
    expect(seen.errors).toEqual([]);
  });
});

describe("#265 PR 3: a pause on the SQLite file", () => {
  test("made on one instance, it is resumed on the other", async ({ app, apps, mockLlm }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Charge, { text: "10 USD" }),
      replyWith(ReceiptDto, { text: "Charged." }),
    );
    const paused = await execute(app, OrderWorkflowStart, { text: "charge" });

    const resumed = await instance(apps, 1).resume(answerOf(paused, approve));

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(resumed.output).toEqual({ text: "Charged." });
    expect(seen.charges).toEqual(["10 USD"]);
  });

  single(
    "it survives a restart: the new instance opens the file and resumes it",
    async ({ app, mockLlm, recoverApp }) => {
      mockLlm(Clerk).thenReturn(
        callTool(Charge, { text: "10 USD" }),
        replyWith(ReceiptDto, { text: "Charged." }),
      );
      const paused = await execute(app, OrderWorkflowStart, { text: "charge" });

      const restarted = await recoverApp();
      const resumed = await restarted.resume(answerOf(paused, approve));

      expect(resumed.status).toBe(ExecutionStatus.Finished);
      expect(resumed.output).toEqual({ text: "Charged." });
    },
  );
});
