import { expect, it } from "vitest";
import type { RunEvent } from "./events.js";
import { harness, NO_JUDGES } from "./fixtures.js";
import { resumeInput, runLoop, startInput, streamLoop } from "./run.js";
import { answer, callTools } from "./scripted-model.js";
import { codeJudge } from "./tool.js";
import type { AnswerMove, ReviewVerdict } from "./types.js";

const thread = { thread: "t-stream" };
const write = { id: "w1", name: "write-file", args: { path: "a.ts", content: "x" } };

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const all: RunEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

const tokenText = (event: RunEvent): string => (event.kind === "token" ? event.text : "");

const shape = (event: RunEvent): string =>
  event.kind === "node-started" || event.kind === "node-finished"
    ? `${event.kind}:${event.node}`
    : event.kind;

it("streams node, tool, pause and done events; tokens carry the answer", async () => {
  const h = harness({ moves: [callTools(write), answer("all done")] });

  const first = await collect(streamLoop(h.graph, startInput("write"), thread));
  const resume = await resumeInput(h.graph, "t-stream", { approved: true, by: "lead" });
  const second = await collect(streamLoop(h.graph, resume, thread));

  expect(first.map(shape)).toEqual([
    "node-started:model",
    "node-finished:model",
    "node-started:review",
    "node-finished:review",
    "node-started:approval",
    "node-finished:approval",
    "paused",
  ]);
  expect(second.map(shape)).toContain("tool-called");
  expect(second.map(tokenText).join("")).toBe("all done");
  expect(second.at(-1)).toEqual({ kind: "done", answer: "all done" });
});

it("agrees with run: the last stream event is the run result", async () => {
  const streamed = harness({ moves: [answer("same")] });
  const ran = harness({ moves: [answer("same")] });

  const events = await collect(streamLoop(streamed.graph, startInput("go"), thread));
  const result = await runLoop(ran.graph, startInput("go"), thread);

  expect(events.at(-1)).toEqual(result);
});

it("is cancelled by an AbortSignal mid-answer", async () => {
  const h = harness({ moves: [answer("a long streamed answer", 5)] });
  const controller = new AbortController();
  const events: RunEvent[] = [];

  for await (const event of streamLoop(h.graph, startInput("go"), {
    ...thread,
    signal: controller.signal,
  })) {
    events.push(event);
    if (event.kind === "token") controller.abort();
  }

  expect(events.at(-1)).toEqual({ kind: "cancelled" });
  expect(events.filter((e) => e.kind === "token").length).toBeLessThan(5);
});

it("stops the run and its running tool when the consumer breaks out of the loop", async () => {
  const h = harness({
    moves: [callTools({ id: "t", name: "wait", args: { ms: 50 } }), answer("never")],
  });

  for await (const event of streamLoop(h.graph, startInput("go"), thread)) {
    if (event.kind === "tool-called") break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(h.effects).toEqual([]);
  expect(h.modelCalls).toEqual([0]);
});

it("has already streamed the tokens of an answer that a judge then returns (the spec needs an event for it)", async () => {
  const complete = codeJudge<AnswerMove, ReviewVerdict>("answer-complete", 1, (move) =>
    move.text.includes("tests") ? { kind: "accept" } : { kind: "revise", remark: "tests?" },
  );
  const judges = { ...NO_JUDGES, beforeAnswer: [complete] };
  const h = harness({ moves: [answer("done. "), answer("done, tests pass")], judges });

  const events = await collect(streamLoop(h.graph, startInput("go"), thread));

  expect(events.map(tokenText).join("")).toBe("done. done, tests pass");
  expect(events.at(-1)).toEqual({ kind: "done", answer: "done, tests pass" });
});
