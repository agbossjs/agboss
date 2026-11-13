/** #1004 AC1: the summary of the thread's older turns never reaches the next turn's stream. */
import { describe, expect } from "vitest";
import { replyWith, testWith } from "../../src/testing/index.js";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { execute } from "../helpers/flow.js";
import {
  DeskStart,
  EagerAgent,
  EagerCompaction,
  EagerDeskApplication,
} from "../compaction/compaction.fixture.js";
import { deltas } from "./writer.fixture.js";

const test = testWith(EagerDeskApplication);

describe("#1004: compaction is silent", () => {
  test("AC1: the summary is not a delta, the answer is", async ({ app, mockLlm }) => {
    mockLlm(EagerAgent).thenReturn(replyWith("answer 1"), replyWith("answer 2"));
    mockLlm(EagerCompaction).thenReturn(replyWith("SUMMARY OF EARLIER TURNS"));
    const first = await execute(app, DeskStart, { text: "t1" });
    const events: ExecutionStreamEvent[] = [];

    await execute(
      app,
      DeskStart,
      { text: "t2" },
      { threadId: first.threadId, onStream: (event) => events.push(event) },
    );

    expect(mockLlm(EagerCompaction).requests.length).toBeGreaterThan(0);
    expect(deltas(events)).toEqual(["answer 2"]);
  });
});
