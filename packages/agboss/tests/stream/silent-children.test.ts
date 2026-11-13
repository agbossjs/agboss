/** #1004 AC1: a child workflow's judge stays silent; its agent's answer streams, also from parallel children. */
import { describe, expect } from "vitest";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { ChildWriter, FlowJudge } from "./agents.fixture.js";
import { canaries, useCanary } from "./canary.js";
import { FanStart, OnceStart, StreamChildrenApplication } from "./children.fixture.js";
import { deltas } from "./writer.fixture.js";

useCanary();
const test = testWith(StreamChildrenApplication);

describe("#1004: child workflows", () => {
  test("AC1: a child workflow's agent streams its answer, its judge nothing", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ChildWriter).thenReturn(replyWith("From the child."));
    mockLlm(FlowJudge).thenReturnAlways(replyWith("PASS: INTERNAL"));
    const events: ExecutionStreamEvent[] = [];

    await execute(app, OnceStart, { text: "Q" }, { onStream: (event) => events.push(event) });

    expect(mockLlm(FlowJudge).requests).toHaveLength(1);
    expect(deltas(events)).toEqual(["CANARY", "From the child."]);
  });

  test("AC1: parallel children: every answer once, no judge", async ({ app, mockLlm }) => {
    mockLlm(ChildWriter).thenReturn(replyWith("One."), replyWith("Two."));
    mockLlm(FlowJudge).thenReturnAlways(replyWith("PASS: INTERNAL"));
    const events: ExecutionStreamEvent[] = [];

    await execute(app, FanStart, [{ text: "a" }, { text: "b" }], {
      onStream: (event) => events.push(event),
    });

    expect(mockLlm(FlowJudge).requests).toHaveLength(2);
    expect(canaries(events)).toBe(2);
    expect(
      deltas(events)
        .filter((delta) => delta !== "CANARY")
        .sort(),
    ).toEqual(["One.", "Two."]);
  });
});
