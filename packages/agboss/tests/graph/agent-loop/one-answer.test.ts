/**
 * #649 — an agent whose only tool is its answer tool answers with one call. AC1: its requests to an
 * OpenAI-compatible server carry `parallel_tool_calls: false` (on the wire); an agent with a tool of
 * its own, or a list of variants (several answer tools in one move, S6), does not. AC2: a move that
 * still holds several answer calls is the one answer when they repeat it exactly, and refused —
 * never one of them picked — when they differ: the step fails naming the different answers.
 */
import { describe, expect, it } from "vitest";
import { Text } from "../../../src/dto/index.js";
import { listOf, oneOf } from "../../../src/flow/dto-wrappers.js";
import {
  answerToolsOf,
  NO_ANSWER_TOOLS,
  toolBindingOf,
} from "../../../src/flow/runtime/answer-tools.js";
import { AgentAnswerInvalidError } from "../../../src/index.js";
import { nameOf } from "../../../src/components/name-of.js";
import type { App } from "../../../src/app/types.js";
import type { AnyTool } from "../../../src/tools/index.js";
import { execute } from "../../helpers/flow.js";
import { appWithKeys } from "../../models/gateway.js";
import {
  providerStub,
  toolCallCompletion,
  toolCallsCompletion,
  type StubReply,
  type StubRequest,
} from "../../models/stub.js";
import {
  LegalReviewDto,
  OneAnswerApplication,
  ReadingWorkflowFinish,
  ReadingWorkflowStart,
  ReviewWorkflowFinish,
  ReviewWorkflowStart,
} from "./fixtures/one-answer.workflow.js";

const ANSWER = "answer-legal-review-dto";
const clause = (text: string) => ({ name: ANSWER, args: { clause: text } });

/** The application on a stubbed OpenAI-compatible server answering `replies`, in order. */
async function appAnswering(
  replies: readonly StubReply[],
): Promise<{ readonly app: App; readonly chats: () => readonly StubRequest[] }> {
  const stub = providerStub(replies, [{ id: "wire/model" }]);
  const app = await appWithKeys(OneAnswerApplication, {
    processEnv: {},
    providerFetch: stub.fetch,
  });
  const chats = () => stub.requests.filter((request) => request.url.endsWith("/chat/completions"));
  return { app, chats };
}

describe("#649 AC1: an answer-only agent asks for one tool call per move, on the wire", () => {
  it("AC1: its request says parallel_tool_calls: false", async () => {
    const { app, chats } = await appAnswering([toolCallCompletion(ANSWER, { clause: "4.2" })]);

    const result = await execute(app, ReviewWorkflowStart, { text: "the lease" });

    expect(result.finish).toMatchObject({ name: nameOf(ReviewWorkflowFinish) });
    expect(result.output).toEqual({ clause: "4.2" });
    expect(chats().map((request) => request.body?.parallel_tool_calls)).toEqual([false]);
    await app.close();
  });

  it("AC1: an agent with a tool of its own sends no parallel_tool_calls", async () => {
    const { app, chats } = await appAnswering([
      toolCallsCompletion([
        { name: "clause-text-tool", args: { number: "1" } },
        { name: "clause-text-tool", args: { number: "2" } },
      ]),
      toolCallCompletion(ANSWER, { clause: "clause 2" }),
    ]);

    const result = await execute(app, ReadingWorkflowStart, { text: "the lease" });

    expect(result.finish).toMatchObject({ name: nameOf(ReadingWorkflowFinish) });
    expect(chats()).toHaveLength(2);
    expect(chats().map((request) => "parallel_tool_calls" in (request.body ?? {}))).toEqual([
      false,
      false,
    ]);
    await app.close();
  });

  it("AC1: a list of variants may answer with several calls: no parallel_tool_calls for it", () => {
    class NoClauseDto {
      @Text({ prompt: "why no clause applies" })
      reason!: string;
    }
    const tools: readonly AnyTool[] = [];

    expect(toolBindingOf({ tools, answerTools: answerToolsOf(LegalReviewDto) })).toEqual({
      parallel_tool_calls: false,
    });
    expect(toolBindingOf({ tools, answerTools: answerToolsOf(listOf(LegalReviewDto)) })).toEqual({
      parallel_tool_calls: false,
    });
    expect(
      toolBindingOf({
        tools,
        answerTools: answerToolsOf(listOf(oneOf(LegalReviewDto, NoClauseDto))),
      }),
    ).toEqual({});
    expect(toolBindingOf({ tools, answerTools: NO_ANSWER_TOOLS })).toEqual({});
  });
});

describe("#649 AC2: several answer calls in one move", () => {
  it("AC2: the same answer repeated is the one answer: no attempt burnt", async () => {
    const { app, chats } = await appAnswering([
      toolCallsCompletion([clause("4.2"), clause("4.2"), clause("4.2")]),
    ]);

    const result = await execute(app, ReviewWorkflowStart, { text: "the lease" });

    expect(result.output).toEqual({ clause: "4.2" });
    expect(chats()).toHaveLength(1);
    await app.close();
  });

  it("AC2: different answers are refused, never one picked: the step fails naming them", async () => {
    const { app, chats } = await appAnswering([
      toolCallsCompletion([clause("4.2"), clause("7.1"), clause("9")]),
    ]);

    const run = execute(app, ReviewWorkflowStart, { text: "the lease" });

    await expect(run).rejects.toFailWith(AgentAnswerInvalidError, {
      code: "step.agent.invalid-answer",
    });
    await expect(run).rejects.toThrow(
      `3 different answers in one move (${ANSWER}): the agent answers once`,
    );
    expect(chats()).toHaveLength(3);
    await app.close();
  });

  it("AC2: refused, the model reads why and may answer once on its next attempt", async () => {
    const { app, chats } = await appAnswering([
      toolCallsCompletion([clause("4.2"), clause("7.1")]),
      toolCallCompletion(ANSWER, { clause: "7.1" }),
    ]);

    const result = await execute(app, ReviewWorkflowStart, { text: "the lease" });

    expect(result.output).toEqual({ clause: "7.1" });
    expect(JSON.stringify(chats()[1]?.body?.messages)).toContain(
      "call exactly one answer tool when ready to finish",
    );
    await app.close();
  });
});
