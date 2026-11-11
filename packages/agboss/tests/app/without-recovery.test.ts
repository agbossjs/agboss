/**
 * #860 (design §5): a run a transport marks `withoutRecovery` — a direct A2A reply, whose caller
 * waits for this pass alone — is never continued by another instance: its holder down, the
 * recovery that takes its lease ends it as cancelled without a pass (no model called again, its
 * record failed); a run without the mark is continued as before; a live run is not touched by it.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { withoutRecovery } from "../../src/app/tree-control.js";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { ExecutionLeaseLostError, ResumeReason } from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
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
  stores,
} from "../infrastructure/fixtures/recovery.workflow.js";

const test = testWith(RecoveryApplication, { instances: 2 });
const THREAD = "t-1";

beforeEach(resetRecovery);
afterEach(() => {
  vi.restoreAllMocks();
});

async function pair(apps: readonly TestApp[]): Promise<readonly [TestApp, TestApp]> {
  const [first, second] = apps;
  if (first === undefined || second === undefined) throw new Error("the test runs two instances");
  await first.ready();
  await second.ready();
  return [first, second];
}

/** Starts an execution on `app` that steps and then holds; resolves once it holds. */
async function holding(
  app: TestApp,
  isMarked: boolean,
): Promise<{ readonly call: Promise<unknown> }> {
  const held = new Promise<void>((resolve) => {
    levers.holdStarted = resolve;
  });
  const options = { threadId: THREAD };
  const call = execute(
    app,
    OrderWorkflowStart,
    { text: "step, then hold" },
    isMarked ? withoutRecovery(options) : options,
  );
  call.catch(() => undefined);
  await held;
  return { call };
}

const lastStatus = async (): Promise<string | undefined> =>
  (await stores.records?.lastTerns("default", THREAD, 1))?.[0]?.status;

const stepAndHold = [
  callTool(Step, { text: "one" }),
  callTool(Hold, { text: "a long job" }),
] as const;

describe("#860: a run no recovery continues", () => {
  test("its holder down, recovery ends it as cancelled: no pass, no model called again", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    // the script is the expectation: a call past it fails the test (no model called again)
    mockLlm(Clerk).thenReturn(...stepAndHold);
    const [first] = await pair(apps);
    const { call } = await holding(first, true);
    kill("instance-1");

    await clock.advance(seconds(31));

    await expect(call).rejects.toBeInstanceOf(ExecutionLeaseLostError);
    expect(seen.errors.map((error) => error.constructor)).toEqual([ExecutionCancelledError]);
    expect(seen.resumes).toEqual([]);
    expect(seen.holds).toHaveLength(1);
    expect(mockLlm(Clerk).requests).toHaveLength(2);
    expect(await lastStatus()).toBe("failed");
  });

  test("its holder alive, the mark changes nothing: it ends at its finish", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepAndHold, replyWith(ReceiptDto, { text: "Done." }));
    const [first] = await pair(apps);
    const { call } = await holding(first, true);

    levers.letGo?.();

    await expect(call).resolves.toMatchObject({ output: { text: "Done." } });
    expect(seen.errors).toEqual([]);
  });

  test("the same run without the mark is recovered: the bite of the case above", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      ...stepAndHold,
      callTool(Hold, { text: "a long job" }),
      replyWith(ReceiptDto, { text: "Done." }),
    );
    const [first] = await pair(apps);
    const { call } = await holding(first, false);
    kill("instance-1");

    await clock.advance(seconds(31));
    const [recovered] = await ends(1);

    await expect(call).rejects.toBeInstanceOf(ExecutionLeaseLostError);
    expect(recovered?.output).toEqual({ text: "Done." });
    expect(seen.resumes.map((resume) => resume.reason)).toEqual([ResumeReason.Recovered]);
  });
});
