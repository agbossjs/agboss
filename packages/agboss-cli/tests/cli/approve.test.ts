/**
 * The terminal's approval loop of `agboss run` / `agboss chat`: a paused run asks in the terminal and
 * continues in the same process — on a real app (`testWith`), its models scripted.
 */
import { executeUnchecked } from "agboss/internal";
import { ExecutionStatus } from "agboss";
import { callTool, replyWith, routeTo, testWith } from "agboss/testing";
import { describe, expect, vi } from "vitest";
import {
  ChatStart,
  DeskApplication,
  MainRouter,
  NotesServer,
  Reply,
  SaveNote,
  Support,
} from "../../../agboss/tests/testing/fixtures/desk.workflow.js";
import {
  memoryLine,
  outputText,
  summaryLine,
  terminalDecision,
  threadLine,
  untilDone,
} from "../../src/cli/approve.js";

const test = testWith(DeskApplication);

describe("terminal approval (agboss run and agboss chat)", () => {
  test("asks about the pending call; yes runs the tool and the run finishes", async ({
    app,
    mockLlm,
    mcpOf,
  }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Support));
    mockLlm(Support).thenReturn(
      callTool(SaveNote, { title: "n1", text: "call back" }),
      replyWith("Saved."),
    );
    const notes = mcpOf(NotesServer).thenReturn({
      write_file: () => Promise.resolve({ content: "ok" }),
    });
    const ask = vi.fn(() => Promise.resolve("y"));

    const paused = await executeUnchecked(app, ChatStart, { text: "note: call back" });
    const done = await untilDone(paused, app, ask);

    expect(ask).toHaveBeenCalledWith(
      'support-agent wants to call save-note-tool {"title":"n1","text":"call back"} — approve? [y/N] ',
    );
    expect(done).toFinishWith(Reply, { text: "Saved." });
    expect(notes.calls.map((call) => call.tool)).toEqual(["write_file"]);
    expect(summaryLine(done)).toBe(`${done.path.join(" → ")} · finish reply-workflow-finish`);
  });

  test.for(["n", undefined])(
    "anything but yes — here %s — declines: the tool never runs",
    async (reply, { app, mockLlm, mcpOf }) => {
      mockLlm(MainRouter).thenReturn(routeTo(Support));
      mockLlm(Support).thenReturn(
        callTool(SaveNote, { title: "n1", text: "x" }),
        replyWith("Not saved."),
      );
      const notes = mcpOf(NotesServer).thenReturn({
        write_file: () => Promise.resolve({ content: "ok" }),
      });

      const paused = await executeUnchecked(app, ChatStart, { text: "note: x" });
      const done = await untilDone(paused, app, () => Promise.resolve(reply));

      expect(done).toFinishWith(Reply, { text: "Not saved." });
      expect(notes.calls).toEqual([]);
    },
  );
});

describe("terminal lines", () => {
  test("#267: the terminal gives a reason when declined; who answered is the thread's owner, not a field", () => {
    expect(terminalDecision(true)).toEqual({ approved: true });
    expect(terminalDecision(false)).toEqual({
      approved: false,
      reason: "declined in the terminal",
    });
  });

  test("the thread line links the trace when tracing is on", () => {
    expect(threadLine({ threadId: "t1", traceUrl: "http://traces/sessions/t1" })).toBe(
      "thread t1 · http://traces/sessions/t1",
    );
    expect(threadLine({ threadId: "t1" })).toBe("thread t1");
  });

  test("a run without a path says so; a paused one says it waits", () => {
    expect(summaryLine({ path: [], status: ExecutionStatus.Paused })).toBe("(none) · paused");
    expect(outputText({ output: { text: "hi" } })).toBe("hi");
    expect(outputText({ output: { score: 1 } })).toBe('{\n  "score": 1\n}');
    expect(memoryLine({})).toBeUndefined();
  });
});
