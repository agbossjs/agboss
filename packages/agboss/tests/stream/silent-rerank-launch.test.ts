/**
 * #1004 AC1, with the canary: the model reranker and a chat-model launch decider write a token on
 * every call, and none of it reaches the user's stream.
 */
import { describe, expect, it } from "vitest";
import { createAppWith } from "../../src/application/create-app.js";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { decideWith, replyWith, testWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { execute } from "../helpers/flow.js";
import { CustomerReplyDto, LoyaltyOfferDto } from "../flow/fixtures/data-dtos.js";
import { LoyaltyOfferAgent } from "../flow/fixtures/launch.fixture.js";
import {
  PickyAnswerAgent,
  PickyApplication,
  PickyRouter,
  PickyWorkflowStart,
} from "../flow/runtime/fixtures/router-launch.workflow.js";
import { MODEL_CONTEXT, rerankApplication } from "../rag/fixtures/rerank.application.js";
import { canaries, useCanary } from "./canary.js";

const QUESTION = "When does on-call start?";
const RANKING = '{"ranking":[27,1,2]}';

useCanary();

const picky = testWith(PickyApplication);

describe("#1004: a chat-model launch decider is silent", () => {
  picky(
    "AC1: the decider's canary is not heard, the answer agent's is",
    async ({ app, mockLlm }) => {
      mockLlm(PickyRouter).thenReturn(
        decideWith({ "refund-policy-agent": 0, "loyalty-offer-agent": 1 }),
      );
      mockLlm(LoyaltyOfferAgent).thenReturn(replyWith(LoyaltyOfferDto, { offer: "10% off" }));
      mockLlm(PickyAnswerAgent).thenReturn(
        replyWith(CustomerReplyDto, { text: "Here you go.", holdForReview: false }),
      );
      const events: ExecutionStreamEvent[] = [];

      await execute(
        app,
        PickyWorkflowStart,
        { text: "I always buy here" },
        { onStream: (event) => events.push(event) },
      );

      expect(mockLlm(PickyRouter).requests).toHaveLength(1);
      expect(canaries(events)).toBe(0); // both agents answer with answer tools: no text at all
      expect(events).toEqual([]);
    },
  );
});

describe("#1004: the model reranker is silent", () => {
  it("AC1: the reranker's call writes a canary; the agent's own answer is the only text heard", async () => {
    const book = new ScriptBook();
    book.scriptOf("reranker:docs-reranker").thenReturn(replyWith(RANKING));
    book.scriptOf("agent:model-context-agent").thenReturn(replyWith("done"));
    const app = await createAppWith(rerankApplication(), { gateway: createScriptedGateway(book) });
    const events: ExecutionStreamEvent[] = [];

    await execute(
      app,
      MODEL_CONTEXT.start,
      { text: QUESTION },
      { onStream: (event) => events.push(event) },
    );

    expect(book.scriptOf("reranker:docs-reranker").requests).toHaveLength(1);
    expect(canaries(events)).toBe(1); // the agent's own call
    expect(events.map((event) => (event.kind === "textDelta" ? event.delta : event.kind))).toEqual([
      "CANARY",
      "done",
    ]);
    await app.close();
  });
});
