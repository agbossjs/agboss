import { MemorySaver } from "@langchain/langgraph";
import { expect, it } from "vitest";
import { harness } from "./fixtures.js";
import { resumeInput, runLoop, startInput, ResumeError, loopStateOf, isPaused } from "./run.js";
import { answer, callTools, type ScriptedMove } from "./scripted-model.js";

const thread = { thread: "t-approval" };
const write = (id: string, path: string) => ({
  id,
  name: "write-file",
  args: { path, content: "x" },
});
const script: readonly ScriptedMove[] = [callTools(write("w1", "a.ts")), answer("written")];

it("pauses before a tool that needs approval; a fresh graph resumes it and the tool runs once", async () => {
  const checkpointer = new MemorySaver();
  const before = harness({ moves: script }, checkpointer);

  const paused = await runLoop(before.graph, startInput("write a.ts"), thread);
  const after = harness({ moves: script }, checkpointer);
  const resume = await resumeInput(after.graph, "t-approval", { approved: true, by: "lead" });
  const done = await runLoop(after.graph, resume, thread);

  expect(paused).toEqual({
    kind: "paused",
    question: {
      kind: "tool-approval",
      callId: "w1",
      tool: "write-file",
      args: { path: "a.ts", content: "x" },
    },
  });
  expect(before.effects).toEqual([]);
  expect(after.effects).toEqual(["write a.ts=x"]);
  expect(before.modelCalls).toEqual([0]);
  expect(after.modelCalls).toEqual([1]);
  expect(done).toEqual({ kind: "done", answer: "written" });
});

it("does not run a rejected call and tells the agent who rejected it", async () => {
  const h = harness({ moves: script });
  await runLoop(h.graph, startInput("write"), thread);

  const resume = await resumeInput(h.graph, "t-approval", {
    approved: false,
    by: "lead",
    note: "not now",
  });
  await runLoop(h.graph, resume, thread);

  expect(h.effects).toEqual([]);
  const state = await loopStateOf(h.graph, "t-approval");
  expect(state.messages.map((m) => m.text)).toContain("Not run: rejected by lead — not now");
});

it("asks about parallel calls one at a time, one checkpoint per answer", async () => {
  const h = harness({ moves: [callTools(write("w1", "a.ts"), write("w2", "b.ts")), answer("ok")] });

  const first = await runLoop(h.graph, startInput("write"), thread);
  const second = await runLoop(
    h.graph,
    await resumeInput(h.graph, "t-approval", { approved: true, by: "lead" }),
    thread,
  );
  const done = await runLoop(
    h.graph,
    await resumeInput(h.graph, "t-approval", { approved: true, by: "lead" }),
    thread,
  );

  expect(first.kind === "paused" && first.question.callId).toBe("w1");
  expect(second.kind === "paused" && second.question.callId).toBe("w2");
  expect(done.kind).toBe("done");
  expect(h.effects).toEqual(["write a.ts=x", "write b.ts=x"]);
});

it("rejects resume of a run that is not paused", async () => {
  const h = harness({ moves: [answer("hi")] });
  await runLoop(h.graph, startInput("hi"), thread);

  await expect(
    resumeInput(h.graph, "t-approval", { approved: true, by: "lead" }),
  ).rejects.toMatchObject({
    code: "resume.not-paused",
  });
});

it("rejects an answer that does not match the expected shape and stays paused", async () => {
  const h = harness({ moves: script });
  await runLoop(h.graph, startInput("write"), thread);

  const invalid = resumeInput(h.graph, "t-approval", { approved: true, by: "" });

  await expect(invalid).rejects.toBeInstanceOf(ResumeError);
  expect(await isPaused(h.graph, "t-approval")).toBe(true);
});
