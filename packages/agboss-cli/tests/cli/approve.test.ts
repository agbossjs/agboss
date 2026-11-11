/**
 * The terminal's approval loop of `agboss run` / `agboss chat`: a paused run asks in the terminal and
 * continues in the same process — on a real app (`testWith`), its models scripted.
 */
import { executeWithoutInputCheck } from "@agboss/core/internal";
import { ExecutionStatus } from "@agboss/core";
import { callTool, replyWith, routeTo, testWith } from "@agboss/core/testing";
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

import {
  LimitApplication,
  LimitWorkflowFinish,
  LimitWorkflowStart,
} from "./fixtures/question.workflow.js";

const test = testWith(DeskApplication);
const asking = testWith(LimitApplication);

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

    const paused = await executeWithoutInputCheck(app, ChatStart, { text: "note: call back" });
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

      const paused = await executeWithoutInputCheck(app, ChatStart, { text: "note: x" });
      const done = await untilDone(paused, app, () => Promise.resolve(reply));

      expect(done).toFinishWith(Reply, { text: "Not saved." });
      expect(notes.calls).toEqual([]);
    },
  );
});

describe("#659: a question pause in the terminal", () => {
  asking("JSON is the typed answer; one that is not valid is asked again", async ({ app }) => {
    const paused = await executeWithoutInputCheck(app, LimitWorkflowStart, { item: "laptop" });
    const ask = vi
      .fn<(question: string) => Promise<string | undefined>>()
      .mockResolvedValueOnce('{ "approved": true }')
      .mockResolvedValueOnce('{ "approved": true, "limitUsd": 900 }');

    const done = await untilDone(paused, app, ask);

    expect(ask.mock.calls[0]?.[0]).toBe(
      'limit-question asks {"item":"laptop"} — your answer (a line starting with { is the typed answer as JSON, anything else a reply): ',
    );
    expect(ask.mock.calls[1]?.[0]).toMatch(/limitUsd[\s\S]*your answer \(.*\): $/);
    expect(done).toFinishWith(LimitWorkflowFinish, { approved: true, limitUsd: 900 });
  });

  asking(
    "free text is a reply: without an interpreter it is refused, nothing asked again",
    async ({ app }) => {
      const paused = await executeWithoutInputCheck(app, LimitWorkflowStart, { item: "desk" });

      await expect(
        untilDone(paused, app, () => Promise.resolve("up to 300")),
      ).rejects.toMatchObject({
        name: "ReplyInterpreterMissingError",
      });
    },
  );
});

describe("#891: the answer mode is explicit", () => {
  asking(
    "#891: a line starting with { that is no JSON is asked again — never sent as a free-text reply",
    async ({ app }) => {
      const paused = await executeWithoutInputCheck(app, LimitWorkflowStart, { item: "laptop" });
      const ask = vi
        .fn<(question: string) => Promise<string | undefined>>()
        .mockResolvedValueOnce('{ "approved": tru')
        .mockResolvedValueOnce('{ "approved": true, "limitUsd": 900 }');

      const done = await untilDone(paused, app, ask);

      expect(ask.mock.calls[1]?.[0]).toMatch(/^not valid JSON \(.+\) — a line starting with \{/);
      expect(done).toFinishWith(LimitWorkflowFinish, { approved: true, limitUsd: 900 });
    },
  );

  asking(
    "#891: JSON that does not start with { (a list, a number) is a free-text reply, not the typed answer",
    async ({ app }) => {
      const paused = await executeWithoutInputCheck(app, LimitWorkflowStart, { item: "desk" });

      await expect(
        untilDone(paused, app, () => Promise.resolve('["approved"]')),
      ).rejects.toMatchObject({ name: "ReplyInterpreterMissingError" });
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
