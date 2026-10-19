/**
 * #262 PR 2 — verifying calls (AC9): `mockLlm(X).inputs`, `toHaveBeenCalledWith` (the matcher of
 * `when`), `toHaveBeenCalledTimes`, `toHaveReturned` under Vitest's names; anything that is not a
 * script still gets Vitest's own mock matchers; `toHaveBeenAskedWith` checks the prompt itself.
 */
import { describe, expect, it, vi } from "vitest";
import { callTool, replyWith, routeTo, testWith } from "../../src/testing/index.js";
import {
  ChatApplication,
  IntakeWorkflowStart,
  MainRouter,
  ProfilerAgent,
  ScoutAgent,
} from "../flow/fixtures/chat.fixture.js";
import { OpeningsDto, ProfileDto, ResumeMissingDto } from "../flow/fixtures/dtos.js";
import { WorkflowFinishTextDto } from "../../src/dto/index.js";
import {
  ChatStart,
  DeskApplication,
  MainRouter as DeskRouter,
  OrderBook,
  OrderStatus,
  Support,
  Writer,
} from "./fixtures/desk.workflow.js";
import { execute } from "../helpers/flow.js";

const chat = testWith(ChatApplication);
const desk = testWith(DeskApplication);

const profiled = (summary: string) => replyWith(ProfileDto, { summary });

describe("AC9: what a model was called with, how often, what it returned", () => {
  chat("inputs: the node's input of every call, as it read it", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(routeTo(ProfilerAgent), routeTo(ScoutAgent));
    mockLlm(ProfilerAgent).thenReturn(profiled("TS backend"));
    mockLlm(ScoutAgent).thenReturn(replyWith(OpeningsDto, { openings: "3" }));

    await app.execute(IntakeWorkflowStart, { text: "my resume" });

    expect(mockLlm(ScoutAgent).inputs).toEqual([
      { profile: { producer: ProfilerAgent, value: { summary: "TS backend" } } },
    ]);
    expect(mockLlm(MainRouter).inputs).toHaveLength(2);
  });

  chat("toHaveBeenCalledWith takes the when(…) matcher", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(routeTo(ProfilerAgent), routeTo(ScoutAgent));
    mockLlm(ProfilerAgent).thenReturn(profiled("TS backend"));
    mockLlm(ScoutAgent).thenReturn(replyWith(OpeningsDto, { openings: "3" }));

    await app.execute(IntakeWorkflowStart, { text: "my resume" });

    expect(mockLlm(ScoutAgent)).toHaveBeenCalledWith({ profile: { summary: "TS backend" } });
    expect(mockLlm(ScoutAgent)).not.toHaveBeenCalledWith({ profile: undefined });
    expect(mockLlm(MainRouter)).toHaveBeenCalledWith({ message: { text: "my resume" } });
    expect(() => {
      expect(mockLlm(ScoutAgent)).toHaveBeenCalledWith({ profile: { summary: "Go" } });
    }).toThrow(
      'expected mockLlm(ScoutAgent) to have been called with {"profile":{"summary":"Go"}}, its inputs: {"profile":{"summary":"TS backend"}}',
    );
  });

  chat("toHaveBeenCalledTimes counts model calls", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(routeTo(ProfilerAgent), routeTo(ScoutAgent));
    mockLlm(ProfilerAgent).thenReturn(profiled("TS"));
    mockLlm(ScoutAgent).thenReturn(replyWith(OpeningsDto, { openings: "3" }));

    await app.execute(IntakeWorkflowStart, { text: "my resume" });

    expect(mockLlm(ScoutAgent)).toHaveBeenCalledTimes(1);
    expect(mockLlm(MainRouter)).toHaveBeenCalledTimes(2);
    expect(() => {
      expect(mockLlm(ScoutAgent)).toHaveBeenCalledTimes(2);
    }).toThrow(
      "expected mockLlm(ScoutAgent) to have been called 2 time(s), it was called 1 time(s)",
    );
  });

  chat("toHaveReturned names the class and some fields of an answer", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(routeTo(ProfilerAgent));
    mockLlm(ProfilerAgent).thenReturn(replyWith(ResumeMissingDto, { reason: "no file" }));

    await app.execute(IntakeWorkflowStart, { text: "hi" });

    expect(mockLlm(ProfilerAgent)).toHaveReturned(ResumeMissingDto);
    expect(mockLlm(ProfilerAgent)).toHaveReturned(ResumeMissingDto, { reason: "no file" });
    expect(mockLlm(ProfilerAgent)).not.toHaveReturned(ProfileDto);
    expect(() => {
      expect(mockLlm(ProfilerAgent)).toHaveReturned(ResumeMissingDto, { reason: "other" });
    }).toThrow('it returned ResumeMissingDto {"reason":"no file"}');
  });

  desk("a text reply is a WorkflowFinishTextDto", async ({ app, mockLlm }) => {
    mockLlm(DeskRouter).thenReturn(routeTo(Writer));
    mockLlm(Writer).thenReturn(replyWith("Hello."));

    await execute(app, ChatStart, { text: "hi" });

    expect(mockLlm(Writer)).toHaveReturned(WorkflowFinishTextDto, { text: "Hello." });
    expect(mockLlm(DeskRouter)).toHaveBeenAskedWith({ input: "hi" });
  });
});

describe("AC9: anything that is not a script keeps Vitest's own matchers", () => {
  it("a vi.fn() is checked by Vitest", () => {
    const send = vi.fn();
    send("a", 1);

    expect(send).toHaveBeenCalledWith("a", 1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveReturned();
    expect(() => {
      expect(send).toHaveBeenCalledWith("b");
    }).toThrow(/expected "spy" to be called with arguments/);
  });

  desk(
    "a mockOf(…) method is a vi.fn(): the same matchers apply to it",
    async ({ app, mockLlm, mockOf }) => {
      mockOf(OrderBook).statusOf.mockResolvedValue("lost");
      mockLlm(DeskRouter).thenReturn(routeTo(Support));
      mockLlm(Support).thenReturn(callTool(OrderStatus, { orderId: "7" }), replyWith("Lost."));

      await execute(app, ChatStart, { text: "where is 7?" });

      expect(mockOf(OrderBook).statusOf.mock.calls).toEqual([["7"]]);
    },
  );
});
