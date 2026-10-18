import { expect, it } from "vitest";
import { harness, NO_JUDGES, pathInsideRepository } from "./fixtures.js";
import { runLoop, startInput, loopStateOf } from "./run.js";
import { answer, callTools } from "./scripted-model.js";
import { codeJudge } from "./tool.js";
import type {
  AnswerMove,
  ReviewVerdict,
  ToolCallMove,
  CallVerdict,
  ToolResultMove,
} from "./types.js";

const thread = { thread: "t-judges" };
const read = (id: string, path: string) => callTools({ id, name: "read-file", args: { path } });
const stateOf = (h: ReturnType<typeof harness>) => loopStateOf(h.graph, "t-judges");
const readJudged = {
  ...NO_JUDGES,
  beforeCall: [{ tool: "read-file", judge: pathInsideRepository(2) }],
};

it("returns a move to the model with the judge's remark; the model redoes it; the bad call never runs", async () => {
  const h = harness({
    moves: [read("c1", "/etc/passwd"), read("c2", "src/a.ts"), answer("ok")],
    judges: readJudged,
  });

  const result = await runLoop(h.graph, startInput("read"), thread);

  expect(result.kind).toBe("done");
  expect(h.effects).toEqual(["read src/a.ts"]);
  const state = await stateOf(h);
  expect(state.messages.map((m) => m.text)).toContain(
    "Not run, returned for revision: /etc/passwd is outside the repository",
  );
  expect(state.revisions).toEqual({ "path-inside-repository@beforeCall": 1 });
});

it("lets the move through with an exhausted record once maxRevisions is spent", async () => {
  const bad = (id: string) => read(id, "/abs");
  const h = harness({ moves: [bad("c1"), bad("c2"), bad("c3"), answer("ok")], judges: readJudged });

  await runLoop(h.graph, startInput("read"), thread);

  expect(h.modelCalls).toEqual([0, 1, 2, 3]);
  expect(h.effects).toEqual(["read /abs"]);
  const log = (await stateOf(h)).judgeLog;
  expect(log.map((r) => r.exhausted)).toEqual([false, false, true]);
});

it("caps revisions of all judges together with maxRevisionsPerStep", async () => {
  const h = harness({
    moves: [read("c1", "/abs"), read("c2", "/abs"), answer("ok")],
    judges: readJudged,
    maxRevisionsPerStep: 1,
  });

  await runLoop(h.graph, startInput("read"), thread);

  expect(h.effects).toEqual(["read /abs"]);
});

it("rejects a call: the tool does not run and the agent reads why", async () => {
  const noSecrets = codeJudge<ToolCallMove, CallVerdict>("no-secrets", 0, () => ({
    kind: "reject",
    reason: "secrets are off limits",
  }));
  const judges = { ...NO_JUDGES, beforeCall: [{ tool: "read-file", judge: noSecrets }] };
  const h = harness({ moves: [read("c1", ".env"), answer("cannot")], judges });

  await runLoop(h.graph, startInput("read"), thread);

  expect(h.effects).toEqual([]);
  const texts = (await stateOf(h)).messages.map((m) => m.text);
  expect(texts).toContain("Not run: rejected by judge — secrets are off limits");
});

it("returns an incomplete answer at beforeAnswer and accepts the redone one", async () => {
  const complete = codeJudge<AnswerMove, ReviewVerdict>("answer-complete", 1, (move) =>
    move.text.includes("tests")
      ? { kind: "accept" }
      : { kind: "revise", remark: "mention the tests" },
  );
  const h = harness({
    moves: [answer("done"), answer("done, tests pass")],
    judges: { ...NO_JUDGES, beforeAnswer: [complete] },
  });

  const result = await runLoop(h.graph, startInput("go"), thread);

  expect(result).toEqual({ kind: "done", answer: "done, tests pass" });
});

it("asks for another call at afterCall when a result is not usable", async () => {
  const notEmpty = codeJudge<ToolResultMove, ReviewVerdict>("not-empty", 1, (move) =>
    move.result === ""
      ? { kind: "revise", remark: "empty — try another file" }
      : { kind: "accept" },
  );
  const judges = { ...NO_JUDGES, afterCall: [{ tool: "read-file", judge: notEmpty }] };
  const h = harness({
    moves: [read("c1", "empty.txt"), read("c2", "b.txt"), answer("ok")],
    judges,
  });

  await runLoop(h.graph, startInput("read"), thread);

  expect(h.effects).toEqual(["read empty.txt", "read b.txt"]);
  const texts = (await stateOf(h)).messages.map((m) => m.text);
  expect(texts).toContain("A reviewer looked at the results: empty — try another file");
});

it("runs a tool-owned judge before approval: a person is never asked about a move that gets revised", async () => {
  const write = (id: string, path: string) =>
    callTools({ id, name: "write-file", args: { path, content: "x" } });
  const h = harness({
    moves: [write("w1", "/abs.ts"), write("w2", "src/a.ts"), answer("ok")],
    beforeWrite: [pathInsideRepository()],
  });

  const result = await runLoop(h.graph, startInput("write"), thread);

  expect(result.kind === "paused" && result.question.callId).toBe("w2");
  expect(h.modelCalls).toEqual([0, 1]);
});
