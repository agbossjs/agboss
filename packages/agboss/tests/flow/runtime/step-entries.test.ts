/**
 * #367 — the running step bodies of an instance, per tree: an entry closes when its body's own
 * promise settles; `closedOf` / `allClosed` wait for every body of a tree (also those opened
 * meanwhile) up to the caller's bound, with the ones still running then.
 */
import { describe, expect, it } from "vitest";
import { runInFrame, type FrameSpec } from "../../../src/flow/context/frame.js";
import {
  inCurrentStepEntry,
  inStepEntry,
  StepEntries,
} from "../../../src/flow/runtime/step-entries.js";
import { testFrame } from "../../helpers/frame.js";

/** A body that runs until `finish` is called (`fail: true` rejects it). */
function pendingBody(): { readonly body: Promise<string>; finish(fail?: boolean): void } {
  let finish: (fail?: boolean) => void = () => undefined;
  const body = new Promise<string>((resolve, reject) => {
    finish = (fail = false) => {
      if (fail) reject(new Error("the body failed"));
      else resolve("done");
    };
  });
  return {
    body,
    finish: (fail) => {
      finish(fail);
    },
  };
}

const frameWith = (nodeId = "slow-action"): FrameSpec => {
  const frame = testFrame();
  return { ...frame, step: { ...frame.step, nodeId } };
};

const treeOf = (frame: FrameSpec): { tenantId: string; rootExecutionId: string } => ({
  tenantId: frame.execution.tenant.tenantId,
  rootExecutionId: frame.execution.executionId,
});

describe("#367: StepEntries", () => {
  it("an entry is open until its body settles — a rejecting one too — with ids only", async () => {
    const steps = new StepEntries();
    const frame = frameWith();
    const first = pendingBody();
    const second = pendingBody();
    const one = steps.track(frame, () => first.body);
    const two = inStepEntry(steps, frameWith("other-action"), () => second.body);
    two.catch(() => undefined);

    expect(steps.openOf(treeOf(frame)).map((entry) => entry.nodeId)).toEqual([
      "slow-action",
      "other-action",
    ]);
    expect(steps.open()[0]).toMatchObject({
      tenantId: "default",
      executionId: frame.execution.executionId,
      rootExecutionId: frame.execution.executionId,
      visitNumber: frame.step.visitNumber,
    });
    first.finish();
    second.finish(true);
    await expect(one).resolves.toBe("done");
    await expect(two).rejects.toThrow("the body failed");

    expect(steps.open()).toEqual([]);
  });

  it("closedOf waits for every body, the ones opened meanwhile too, then resolves with none", async () => {
    const steps = new StepEntries();
    const frame = frameWith();
    const first = pendingBody();
    const later = pendingBody();
    void steps.track(frame, () => first.body);
    const closed = steps.closedOf(treeOf(frame), new AbortController().signal);
    void steps.track(frame, () => later.body);
    first.finish();
    await new Promise((resolve) => setImmediate(resolve));

    expect(steps.openOf(treeOf(frame))).toHaveLength(1);
    later.finish();

    await expect(closed).resolves.toEqual([]);
  });

  it("the caller's bound ends the wait with the bodies still running", async () => {
    const steps = new StepEntries();
    const frame = frameWith();
    void steps.track(frame, () => pendingBody().body);
    const bound = new AbortController();
    const closed = steps.allClosed(bound.signal);
    bound.abort();

    const [still] = await closed;
    expect(still?.nodeId).toBe("slow-action");
    expect(await steps.closedOf(treeOf(frame), bound.signal)).toHaveLength(1);
  });

  it("a tool call inside a tracked body is an entry of its own; untracked bodies run as they are", async () => {
    const outside = await inCurrentStepEntry(() => Promise.resolve("outside"));
    const untracked = await inStepEntry(undefined, testFrame(), () =>
      runInFrame(testFrame(), () => inCurrentStepEntry(() => Promise.resolve("untracked"))),
    );
    const steps = new StepEntries();
    const call = frameWith("worker-agent");
    const tracked = await inStepEntry(steps, frameWith("worker-agent"), () =>
      runInFrame({ ...call, step: { ...call.step, callId: "call-1" } }, () =>
        inCurrentStepEntry(async () => {
          await Promise.resolve();
          return steps
            .open()
            .map((entry) => entry.callId ?? "the step")
            .join(" + ");
        }),
      ),
    );

    expect([outside, untracked, tracked]).toEqual(["outside", "untracked", "call-1 + the step"]);
  });
});
