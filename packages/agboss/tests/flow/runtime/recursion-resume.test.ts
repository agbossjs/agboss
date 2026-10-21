import { beforeEach, describe, expect } from "vitest";
import { ApplicationStoppingError } from "../../../src/index.js";
import { ExecutionStatus } from "../../../src/app/types.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../../src/testing/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { seconds } from "../../../src/units/index.js";
import { answerOf, execute } from "../../helpers/flow.js";
import { ends, resetRecovery } from "../../infrastructure/fixtures/recovery.workflow.js";
import {
  CountDoneDto,
  CountDoneWorkflowFinish,
  CountDto,
  recursionLog,
  resetRecursionLog,
} from "./fixtures/recursion.workflow.js";
import {
  ConfirmDigTool,
  DiggerAgent,
  DigWorkflowStart,
  HoldDepthWorkflowStart,
  holds,
  RecursionPauseApplication,
  RecursionRecoveryApplication,
} from "./fixtures/recursion-pause.workflow.js";

/**
 * #264 AC3 — the depth of a recursive execution survives a pause and a crash: a pause inside the
 * level-2 child resumes there (on this instance, or a new one after a restart), and a level-3 step
 * interrupted by its instance's stop is continued by another instance at depth 3.
 */

const test = testWith(RecursionPauseApplication);
const instances = testWith(RecursionRecoveryApplication, { instances: 2 });

const textOf = (request: ModelRequest): string =>
  typeof request.input === "string" ? request.input : JSON.stringify(request.input);

/** Deeper while the count lasts (and the schema lets it); a confirmation first at count 1. */
const digger = (request: ModelRequest) => {
  const left = Number(/"left": (\d+)/.exec(textOf(request))?.[1] ?? "0");
  const isConfirmed =
    request.kind === "chat" && request.messages.some((line) => line.role === "tool");
  const canGoDeeper =
    request.kind === "chat" &&
    request.tools.some((tool) => tool.function.name === "answer-count-dto");
  if (left === 1 && !isConfirmed) return callTool(ConfirmDigTool, { left });
  return left > 0 && canGoDeeper
    ? replyWith(CountDto, { left: left - 1 })
    : replyWith(CountDoneDto, { depth: left });
};

const depthsAt = (at: string): readonly number[] =>
  recursionLog.readings.filter((reading) => reading.at === at).map((reading) => reading.depth);

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

beforeEach(() => {
  resetRecursionLog();
  resetRecovery();
  holds.count = 0;
  delete holds.started;
});

describe("AC3: depth across a pause", () => {
  test("a pause at depth 2 resumes at depth 2; its child is depth 3", async ({ app, mockLlm }) => {
    mockLlm(DiggerAgent).thenAnswer(digger);

    const paused = await execute(app, DigWorkflowStart, { left: 2 });
    const done = await app.resume(answerOf(paused, { approved: true }), {
      tenantId: "default",
    });

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(done).toFinishWith(CountDoneWorkflowFinish, { depth: 0 });
    expect(depthsAt("confirm-dig-tool")).toEqual([2]);
    expect(done.children.map((child) => child.depth)).toEqual([2]);
    expect(done.children[0]?.children.map((child) => child.depth)).toEqual([3]);
  });

  test("after a restart the new instance resumes it at depth 2", async ({
    app,
    recoverApp,
    mockLlm,
  }) => {
    mockLlm(DiggerAgent).thenAnswer(digger);
    const paused = await execute(app, DigWorkflowStart, { left: 2 });

    const restarted = await recoverApp();
    const done = await restarted.resume(answerOf(paused, { approved: true }), {
      tenantId: "default",
    });

    expect(done).toFinishWith(CountDoneWorkflowFinish, { depth: 0 });
    expect(depthsAt("confirm-dig-tool")).toEqual([2]);
    expect(done.children[0]?.children[0]?.depth).toBe(3);
  });
});

describe("AC3: depth across a crash", () => {
  instances(
    "a step held at depth 3 is continued by the other instance at depth 3",
    async ({ apps, clock }) => {
      for (const app of apps) await app.ready();
      const held = new Promise<void>((resolve) => {
        holds.started = resolve;
      });
      const first = instance(apps, 0);
      const call = execute(first, HoldDepthWorkflowStart, { left: 2 });
      call.catch(() => undefined);
      await held;

      await clock.advance(seconds(5));
      const closed = first.close({ timeout: seconds(5) });
      await clock.advance(seconds(5));
      await closed;
      await clock.advance(seconds(20));
      const seen = await ends(3);

      await expect(call).rejects.toBeInstanceOf(ApplicationStoppingError);
      // the levels 3, 2 and 1 end in turn; only the held step ran again, at depth 3
      expect(seen.map((end) => end.finish)).toEqual(Array(3).fill("count-done-workflow-finish"));
      expect(seen.at(-1)?.output).toEqual({ depth: 3 });
      expect(depthsAt("hold-depth-action")).toEqual([1, 2, 3, 3]);
    },
  );
});
