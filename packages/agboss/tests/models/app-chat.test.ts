/**
 * #956 — inside an application the chat model of an OpenAI-compatible provider is the OpenAI client
 * itself, never the lazy stand-in: assembly loads the client, so tracing, usage, ids and the call
 * options are the client's own.
 */
import { ChatOpenAI } from "@langchain/openai";
import { describe, expect, it, vi } from "vitest";
import { nameOf } from "../../src/components/name-of.js";
import { OpenAiCompatibleProvider } from "../../src/models/index.js";
import { execute } from "../helpers/flow.js";
import {
  OneAnswerApplication,
  ReviewWorkflowFinish,
  ReviewWorkflowStart,
} from "../graph/agent-loop/fixtures/one-answer.workflow.js";
import { appWithKeys } from "./gateway.js";
import { providerStub, toolCallCompletion } from "./stub.js";

describe("#956: createApp loads the OpenAI client before any chat model is made", () => {
  it("chat() inside an application returns a ChatOpenAI, not the lazy model", async () => {
    const made = vi.spyOn(OpenAiCompatibleProvider.prototype, "chat");
    const stub = providerStub(
      [toolCallCompletion("answer-legal-review-dto", { clause: "4.2" })],
      [{ id: "wire/model" }],
    );
    const app = await appWithKeys(OneAnswerApplication, {
      processEnv: {},
      providerFetch: stub.fetch,
    });

    const result = await execute(app, ReviewWorkflowStart, { text: "the lease" });
    await app.close();

    expect(result.finish).toMatchObject({ name: nameOf(ReviewWorkflowFinish) });
    expect(made.mock.results.length).toBeGreaterThan(0);
    expect(made.mock.results.map((call) => call.value instanceof ChatOpenAI)).toEqual(
      made.mock.results.map(() => true),
    );
  });
});
