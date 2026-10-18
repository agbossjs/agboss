/**
 * #265 AC12 (S30): recovery — every instance looks for the roots left `running` at its start and
 * every lease length, and continues each whose lease it can take from its last checkpoint, only
 * the interrupted step running again; a graceful stop releases its leases at once; an instance of
 * an incompatible version leaves a root alone; observers get `onWorkflowResume` with
 * `ResumeReason.Recovered`.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import {
  ApplicationStoppingError,
  ExecutionLeaseLostError,
  ExecutionStatus,
  ResumeReason,
} from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  Charge,
  Clerk,
  ends,
  Hold,
  kill,
  levers,
  OrderWorkflowStart,
  ReceiptDto,
  RecoveryApplication,
  resetRecovery,
  seen,
  Step,
} from "./fixtures/recovery.workflow.js";

const test = testWith(RecoveryApplication, { instances: 2 });
const three = testWith(RecoveryApplication, { instances: 3 });
const approve = { approved: true, by: "dana" };

beforeEach(resetRecovery);
afterEach(() => {
  vi.restoreAllMocks();
});

/** The instance `index` of the test (`instances: 2`, `3`). */
const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

/** Builds the instances in order (`instance-1`, `instance-2`, …): each starts its sweep. */
async function ready(apps: readonly TestApp[]): Promise<void> {
  for (const app of apps) await app.ready();
}

/** An execution started on an instance: its call, settled only when it ends. */
interface StartedExecution {
  readonly call: Promise<unknown>;
}

/** Starts an execution on `app` that takes a step and then holds; resolves once it holds. */
async function holding(app: TestApp): Promise<StartedExecution> {
  const held = new Promise<void>((resolve) => {
    levers.holdStarted = resolve;
  });
  const call = app.execute(OrderWorkflowStart, { text: "step, then hold" });
  call.catch(() => undefined);
  await held;
  return { call };
}

/** The model's script of a clerk that steps, holds, then answers. */
const stepHoldAnswer = [
  callTool(Step, { text: "one" }),
  callTool(Hold, { text: "a long job" }),
  replyWith(ReceiptDto, { text: "Done." }),
] as const;

describe("#265 AC12: a root left running by an instance that died", () => {
  test("is continued by the other after the lease, only the interrupted step running again", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepHoldAnswer);
    await ready(apps);
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

  test("is not taken while its lease is valid: nothing happens before it expires", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepHoldAnswer);
    await ready(apps);
    await holding(instance(apps, 0));

    await clock.advance(seconds(30));
    await clock.advance(seconds(30));

    expect(seen.holds).toHaveLength(1);
    expect(seen.resumes).toEqual([]);
    levers.letGo?.();
    expect(await ends(1)).toHaveLength(1);
  });

  three(
    "two instances sweeping at once: exactly one continues it",
    async ({ apps, clock, mockLlm }) => {
      mockLlm(Clerk).thenReturn(...stepHoldAnswer);
      await ready(apps);
      await holding(instance(apps, 0));

      kill("instance-1");
      await clock.advance(seconds(31));
      await ends(1);

      expect(seen.ends).toHaveLength(1);
      expect(seen.holds).toHaveLength(2);
      expect(seen.resumes.map((resume) => resume.reason)).toEqual([ResumeReason.Recovered]);
      expect(seen.leases.filter((lease) => lease.leaseEpoch === 2)).toHaveLength(1);
    },
  );

  test("a resolved pause is taken first: the recovered tree goes on with its decision", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Charge, { text: "10 USD" }),
      replyWith(ReceiptDto, { text: "Charged." }),
    );
    await ready(apps);
    const paused = await execute(instance(apps, 0), OrderWorkflowStart, { text: "charge" });
    kill("instance-1");
    const stuck = new AbortController();
    // recorded, then the instance dies before it moves the tree: its call waits for a lease forever
    const answered = instance(apps, 0).resume(paused.thread, approve, { signal: stuck.signal });
    answered.catch(() => undefined);

    await clock.advance(seconds(30));
    const [recovered] = await ends(1);
    stuck.abort();

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(recovered?.output).toEqual({ text: "Charged." });
    expect(seen.charges).toEqual(["10 USD"]);
    expect(seen.resumes).toEqual([{ reason: ResumeReason.Recovered, decision: approve }]);
  });
});

describe("#265 S30: why a run continues", () => {
  test("a resume answers its pause: ResumeReason.Answered, with the decision", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Charge, { text: "10 USD" }),
      replyWith(ReceiptDto, { text: "Charged." }),
    );
    const paused = await execute(app, OrderWorkflowStart, { text: "charge" });

    await app.resume(paused.thread, approve);

    expect(seen.resumes).toEqual([{ reason: ResumeReason.Answered, decision: approve }]);
  });
});

describe("#265 AC12 / S51: a graceful stop releases its leases at once", () => {
  test("the timeout interrupts the execution, which stays running; the other continues it at its next sweep", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepHoldAnswer);
    await ready(apps);
    const stopping = await holding(instance(apps, 0));

    await clock.advance(seconds(5));
    const closed = instance(apps, 0).close({ timeout: seconds(5) });
    await clock.advance(seconds(5));
    await closed;
    // the last renewal (at 10 s) would keep the lease until 40 s: the sweep at 30 s finds it released
    await clock.advance(seconds(20));
    const [recovered] = await ends(1);

    await expect(stopping.call).rejects.toBeInstanceOf(ApplicationStoppingError);
    expect(seen.holds.map((signal) => signal.aborted)).toEqual([true, false]);
    expect(recovered?.output).toEqual({ text: "Done." });
    expect(seen.steps).toEqual(["one"]);
    expect(seen.errors).toEqual([]);
    expect(seen.leases.map((lease) => lease.holderInstanceId)).toEqual([
      "instance-1",
      "instance-2",
    ]);
  });
});

describe("#265 AC12: an incompatible version", () => {
  test("is not continued: the root is left to a compatible instance, logged once by each", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    mockLlm(Clerk).thenReturn(...stepHoldAnswer);
    await ready(apps);
    await holding(instance(apps, 0));
    kill("instance-1");
    levers.stampedHash = "a-config-of-another-deploy";

    await clock.advance(seconds(31));
    await clock.advance(seconds(30));

    const incompatible = warn.mock.calls.filter(([, options]) =>
      JSON.stringify(options).includes("recovery.incompatible"),
    );
    expect(seen.holds).toHaveLength(1);
    expect(seen.resumes).toEqual([]);
    // two sweeps of two instances: each logs it once
    expect(incompatible).toHaveLength(2);
  });
});
