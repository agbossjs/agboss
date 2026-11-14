/**
 * #1006 AC1: with parallel children and agent chains no two steps share a key — each step's
 * attempts count from 1, and a `discarded` retracts the right step only.
 */
import { describe, expect } from "vitest";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  ChildWriter,
  Closer,
  ColorDto,
  FlowJudge,
  LaunchColor,
  LaunchShape,
  ShapeDto,
  ShapeJudge,
} from "./agents.fixture.js";
import { FanStart, StreamChildrenApplication } from "./children.fixture.js";
import { LaunchStart, StreamFlowApplication } from "./flow.fixture.js";
import { keptText } from "./kept-text.js";

const fan = testWith(StreamChildrenApplication);
const flow = testWith(StreamFlowApplication);

/** `branch|attempt: text` per delta, `branch|attempt: ✗ reason` per retraction; branches numbered as they appear. */
function lines(events: readonly ExecutionStreamEvent[]): string[] {
  const branches = new Map<string, number>();
  return events.flatMap((event) => {
    if (event.kind === "toolCall") return [];
    const branch = branches.get(event.step.branch) ?? branches.size;
    branches.set(event.step.branch, branch);
    const at = `${String(branch)}|${String(event.step.attempt)}`;
    return [event.kind === "textDelta" ? `${at}: ${event.delta}` : `${at}: ✗ ${event.reason}`];
  });
}

describe("#1006: parallel children", () => {
  fan(
    "AC1: two children, the first retried: the steps differ by branch, attempts count apart",
    async ({ app, mockLlm }) => {
      mockLlm(ChildWriter).thenReturn(
        replyWith("BAD zero."),
        replyWith("Good zero."),
        replyWith("One."),
      );
      mockLlm(FlowJudge).thenReturn(replyWith("FAIL"), replyWith("PASS"), replyWith("PASS"));
      const events: ExecutionStreamEvent[] = [];

      const done = await execute(app, FanStart, [{ text: "a" }, { text: "b" }], {
        onStream: (event) => events.push(event),
      });

      expect(lines(events)).toEqual([
        "0|1: BAD zero.",
        "0|1: ✗ judge-rejected",
        "0|2: Good zero.",
        "1|1: One.",
      ]);
      const branches = new Set(
        events.flatMap((event) => (event.kind === "toolCall" ? [] : [event.step.branch])),
      );
      expect(branches.size).toBe(2);
      expect(keptText(events)).toBe("Good zero.One.");
      expect(done.output).toEqual({ text: "Good zero. | One." });
    },
  );
});

describe("#1006: a parallel launch and the agent after it", () => {
  flow(
    "AC1: the branches stream nothing; the closing agent is its own step",
    async ({ app, mockLlm }) => {
      mockLlm(LaunchShape).thenReturn(replyWith(ShapeDto, { shape: "round" }));
      mockLlm(LaunchColor).thenReturn(replyWith(ColorDto, { color: "red" }));
      mockLlm(ShapeJudge).thenReturn(replyWith("PASS"));
      mockLlm(Closer).thenReturn(replyWith("Done."));
      const events: ExecutionStreamEvent[] = [];

      const done = await execute(
        app,
        LaunchStart,
        { text: "Q" },
        { onStream: (event) => events.push(event) },
      );

      expect(events).toEqual([
        {
          kind: "textDelta",
          delta: "Done.",
          step: { agent: "closer-agent", visit: 1, branch: done.executionId, attempt: 1 },
        },
      ]);
    },
  );
});
