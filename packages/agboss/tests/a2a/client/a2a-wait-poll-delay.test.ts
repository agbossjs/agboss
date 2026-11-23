/**
 * #1366: how often a wait for a remote task polls it — 250 ms at first, the delay doubling after each poll to
 * at most 5 s, on the application's clock.
 */
import { TaskState, type Task } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";
import { waitForTask } from "../../../src/a2a/client/a2a-wait.js";
import type { Milliseconds } from "../../../src/units/index.js";

const taskIn = (state: TaskState): Task => ({
  id: "t-1",
  contextId: "c-1",
  status: { state, message: undefined, timestamp: undefined },
  artifacts: [],
  history: [],
  metadata: undefined,
});

describe("#1366: the poll's delays", () => {
  it("double from 250 ms and stop at 5 s", async () => {
    const slept: number[] = [];
    let polls = 0;
    const wait = {
      agent: "peer",
      client: {
        getTask: () => {
          polls += 1;
          return Promise.resolve(
            taskIn(polls > 8 ? TaskState.TASK_STATE_COMPLETED : TaskState.TASK_STATE_WORKING),
          );
        },
      },
      clock: {
        now: () => new Date(0),
        sleep: (delay: Milliseconds) => {
          slept.push(delay);
          return Promise.resolve();
        },
      },
      taskId: "t-1",
      task: undefined,
      isStreaming: false,
      deadlineAt: undefined,
      signal: undefined,
      onEvent: undefined,
    };

    await waitForTask(wait as never);

    expect(slept).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
  });
});
