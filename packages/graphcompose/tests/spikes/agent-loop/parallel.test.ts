import { ToolMessage } from "@langchain/core/messages";
import { expect, it } from "vitest";
import { harness, NO_JUDGES, pathInsideRepository } from "./fixtures.js";
import { runLoop, startInput, loopStateOf } from "./run.js";
import { answer, callTools } from "./scripted-model.js";
import { codeJudge } from "./tool.js";
import type { CallVerdict, ToolCallMove } from "./types.js";

const thread = { thread: "t-parallel" };
const stateOf = (h: ReturnType<typeof harness>) => loopStateOf(h.graph, "t-parallel");
const wait = (id: string, ms: number) => ({ id, name: "wait", args: { ms } });
const read = (id: string, path: string) => ({ id, name: "read-file", args: { path } });

it("runs parallel calls concurrently but answers them in the move's order", async () => {
  const h = harness({
    moves: [callTools(wait("slow", 40), wait("fast", 1), wait("mid", 20)), answer("ok")],
  });

  await runLoop(h.graph, startInput("go"), thread);

  expect(h.effects).toEqual(["waited 1", "waited 20", "waited 40"]);
  const state = await stateOf(h);
  const answered = state.messages.filter((m) => ToolMessage.isInstance(m));
  expect(answered.map((m) => m.tool_call_id)).toEqual(["slow", "fast", "mid"]);
  expect(Object.keys(state.results).sort()).toEqual(["fast", "mid", "slow"]);
});

it("returns the whole parallel move when a judge revises one call; no call of it runs", async () => {
  const judges = {
    ...NO_JUDGES,
    beforeCall: [{ tool: "read-file", judge: pathInsideRepository() }],
  };
  const h = harness({
    moves: [
      callTools(read("a", "ok.ts"), read("b", "/abs"), wait("w", 1)),
      callTools(read("a2", "ok.ts"), read("b2", "rel.ts"), wait("w2", 1)),
      answer("ok"),
    ],
    judges,
  });

  await runLoop(h.graph, startInput("go"), thread);

  expect(h.effects).toEqual(["read ok.ts", "read rel.ts", "waited 1"]);
  const texts = (await stateOf(h)).messages.map((m) => m.text);
  expect(texts).toContain("Not run: the move was returned for revision.");
});

it("runs the other calls of a move when a judge rejects one of them", async () => {
  const noEnv = codeJudge<ToolCallMove, CallVerdict>("no-env", 0, (move) =>
    JSON.stringify(move.args).includes(".env")
      ? { kind: "reject", reason: "no secrets" }
      : { kind: "accept" },
  );
  const judges = { ...NO_JUDGES, beforeCall: [{ tool: "read-file", judge: noEnv }] };
  const h = harness({
    moves: [callTools(read("a", ".env"), read("b", "b.ts")), answer("ok")],
    judges,
  });

  await runLoop(h.graph, startInput("go"), thread);

  expect(h.effects).toEqual(["read b.ts"]);
});
