import { afterEach, describe, expect, vi } from "vitest";
import { testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  CheckItemAction,
  CheckOneWorkflowStart,
  ChildrenApplication,
  OneCheckedWorkflowFinish,
  childLog,
  resetChildLog,
} from "./fixtures/children.workflow.js";
import {
  EmptyEnvironment,
  type ExecutionEndEvent,
  type OnExecutionEnd,
} from "../../../src/index.js";
import { Injectable } from "../../../src/components/decorators.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../fixtures/budgets.js";
import {
  RemoteCheckAction,
  RemoteOneCheckedWorkflowFinish,
  RemoteOneWorkflow,
  RemoteOneWorkflowStart,
  remoteLog,
  resetRemoteLog,
} from "./fixtures/remote-children.workflow.js";

/**
 * #661 — a child's result survives the host's wall clock stepping back while it runs. LangGraph
 * names each checkpoint by a UUIDv6 of `Date.now()` and a saver's latest checkpoint is the
 * greatest id, so after a backward step (an NTP `settimeofday`: −50.8 ms on the machine where the
 * flake was seen) the child's newest checkpoints sort before older ones. Its end is read from the
 * checkpoint its own run wrote last, never from the thread's greatest id: read that way, the
 * checkpoint before its action looked ended — every task written, no output — and the parent got
 * `undefined` for the child's result.
 */

const BACK_STEPS = [50, 3_600_000];

const remoteEnds: ExecutionEndEvent[] = [];

/** Every execution's end: a remote child's is announced by the worker that ran it (#562). */
@Injectable()
export class RemoteEndLog implements OnExecutionEnd {
  onExecutionEnd(event: ExecutionEndEvent): void {
    remoteEnds.push(event);
  }
}

@Application({
  name: "clock-step-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RemoteOneWorkflow],
  observers: [RemoteEndLog],
  budgets: TEST_BUDGETS,
})
export class ClockStepApplication {}

afterEach(() => {
  vi.restoreAllMocks();
  resetChildLog();
  resetRemoteLog();
  remoteEnds.length = 0;
});

/** From the first call of `action`'s `execute` on, the wall clock reads `back` ms earlier. */
function stepTheClockBackAt(
  action: { prototype: { execute: (input: never) => unknown } },
  back: number,
): void {
  const realNow = Date.now.bind(Date);
  const execute = action.prototype.execute;
  vi.spyOn(action.prototype, "execute").mockImplementation(function (this: unknown, input: never) {
    vi.spyOn(Date, "now").mockImplementation(() => realNow() - back);
    return execute.call(this, input);
  });
}

describe("#661: the wall clock steps back while a child on its parent's instance runs", () => {
  const test = testWith(ChildrenApplication);
  const who = { tenant: { tenantId: "acme", plan: "pro" }, execution: { userId: "u1" } };

  for (const back of BACK_STEPS)
    test(`back ${String(back)} ms at its action: its result reaches the parent, once`, async ({
      app,
    }) => {
      stepTheClockBackAt(CheckItemAction, back);

      const result = await execute(
        app,
        CheckOneWorkflowStart,
        { name: "a", delay: 0, outcome: "ok" },
        who,
      );

      expect(result).toFinishWith(OneCheckedWorkflowFinish, { name: "a" });
      expect(childLog.events).toEqual(["start a", "end a"]);
      expect(childLog.ends.map((event) => event.workflow.name)).toEqual([
        "item-check-workflow",
        "check-one-workflow",
      ]);
    });
});

describe("#661: the wall clock steps back while a child on any instance runs", () => {
  const test = testWith(ClockStepApplication);

  for (const back of BACK_STEPS)
    test(`back ${String(back)} ms at its action: its result reaches the parent, once`, async ({
      app,
    }) => {
      stepTheClockBackAt(RemoteCheckAction, back);

      const result = await execute(app, RemoteOneWorkflowStart, {
        name: "a",
        delay: 0,
        outcome: "ok",
      });

      expect(result).toFinishWith(RemoteOneCheckedWorkflowFinish, { name: "a" });
      expect(remoteLog.readings.map((reading) => reading.item)).toEqual(["a"]);
      // the worker that ran it announces its end at its finish, with its spend
      expect(remoteEnds.map((event) => [event.workflow.name, event.finish.name])).toEqual([
        ["remote-item-workflow", "remote-item-checked-workflow-finish"],
        ["remote-one-workflow", "remote-one-checked-workflow-finish"],
      ]);
    });
});
