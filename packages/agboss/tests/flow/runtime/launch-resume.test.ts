import { beforeEach, describe, expect } from "vitest";
import { ApplicationStoppingError } from "../../../src/index.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../../src/testing/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { seconds } from "../../../src/units/index.js";
import { execute, answerOf } from "../../helpers/flow.js";
import { ends, resetRecovery } from "../../infrastructure/fixtures/recovery.workflow.js";
import {
  ItemResultDto,
  ItemsWorkflowStart,
  SummaryWorkflowFinish,
  type ItemDto,
} from "./fixtures/fan-out.workflow.js";
import {
  LaunchRecoveryApplication,
  recoveryRuns,
  resetRecoveryRuns,
} from "./fixtures/launch-recovery.workflow.js";
import {
  ClerkApplication,
  ConfirmItemTool,
  ItemClerkAgent,
} from "./fixtures/launch-runs.workflow.js";

/**
 * #273 S20 (#265): LangGraph keeps each finished branch's writes, so after a restart or a crash
 * only the unfinished branches run again.
 */

const clerks = testWith(ClerkApplication);
const instances = testWith(LaunchRecoveryApplication, { instances: 2 });
const approve = { approved: true };

const item = (name: string): ItemDto => ({ name, delay: 0, outcome: "ok" });

const nameIn = (request: ModelRequest): string => {
  const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
  return /"name": "(\w+)"/.exec(input)?.[1] ?? "?";
};

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

beforeEach(() => {
  resetRecovery();
  resetRecoveryRuns();
});

describe("S20: after a restart only the unfinished branches run again", () => {
  clerks(
    "a paused branch survives a restart: the new instance resumes only it",
    async ({ app, recoverApp, mockLlm }) => {
      mockLlm(ItemClerkAgent).thenAnswer((request) => {
        const name = nameIn(request);
        const confirmed =
          request.kind === "chat" && request.messages.some((line) => line.role === "tool");
        return name === "b" && !confirmed
          ? callTool(ConfirmItemTool, { name })
          : replyWith(ItemResultDto, { name });
      });
      const paused = await execute(app, ItemsWorkflowStart, [item("a"), item("b"), item("c")]);
      const before = mockLlm(ItemClerkAgent).requests.length;

      const restarted = await recoverApp();
      const done = await restarted.resume(answerOf(paused, approve));

      expect(done).toFinishWith(SummaryWorkflowFinish, { text: "a, b, c" });
      expect(mockLlm(ItemClerkAgent).requests.slice(before).map(nameIn)).toEqual(["b"]);
    },
  );

  instances(
    "a crash after some branches: the other instance runs only the interrupted one",
    async ({ apps, clock }) => {
      for (const app of apps) await app.ready();
      const held = new Promise<void>((resolve) => {
        recoveryRuns.holdStarted = resolve;
      });
      const first = instance(apps, 0);
      const call = execute(first, ItemsWorkflowStart, [item("a"), item("hold"), item("c")]);
      call.catch(() => undefined);
      await held;

      await clock.advance(seconds(5));
      const closed = first.close({ timeout: seconds(5) });
      await clock.advance(seconds(5));
      await closed;
      await clock.advance(seconds(20));
      const [recovered] = await ends(1);

      await expect(call).rejects.toBeInstanceOf(ApplicationStoppingError);
      expect(recovered?.output).toEqual({ text: "a, hold, c" });
      expect([...recoveryRuns.runs].sort()).toEqual(["a", "c", "hold", "hold"]);
    },
  );
});
