/**
 * #703 — reranking in the test kit: `testUnit(R)` reranks as an agent's search does (a code reranker
 * from its container, a model one on `model: replyWith(…)`, unscripted the retrieval's order), and
 * `mockModel(Reranker)` scripts a model reranker in `testWith`; a code reranker has no script, named.
 */
import { describe, expect } from "vitest";
import type { Class } from "../../src/index.js";
import type { RagQueryDto } from "../../src/rag/index.js";
import { callTool, replyWith, testUnit, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  ANSWER,
  DocsReranker,
  KeywordRankedRag,
  KeywordReranker,
  MODEL_TOOL,
  ModelRankedRag,
  rerankApplication,
} from "./fixtures/rerank.application.js";

const test = testWith(rerankApplication());

describe("#703: testUnit reranks", () => {
  test("a model reranker on its script; unscripted, the retrieval's order", async () => {
    const scripted = await testUnit(ModelRankedRag, { model: replyWith('{"ranking":[27]}') })(
      "on-call",
    );
    const unscripted = await testUnit(ModelRankedRag)("on-call");

    expect(scripted.output.map((r) => r.source)).toEqual([
      ANSWER.source,
      "near-miss-0.md",
      "near-miss-1.md",
    ]);
    expect(unscripted.output.map((r) => r.source)).toEqual([
      "near-miss-0.md",
      "near-miss-1.md",
      "near-miss-2.md",
    ]);
  });

  test("a code reranker from its container, its cost in the spend", async () => {
    const { output, spend } = await testUnit(KeywordRankedRag)("on-call");

    expect(output[0]?.source).toBe(ANSWER.source);
    expect(spend.byCategory.rag).toBeCloseTo(0.0005, 10);
  });
});

describe("#703: mockModel(Reranker)", () => {
  test("scripts the model reranker of the application", async ({ app, mockModel }) => {
    // a search tool over the knowledge base is a @Tool: callTool names it by its class
    const search = callTool(MODEL_TOOL.tool as Class<{ execute(input: RagQueryDto): unknown }>, {
      query: "on-call",
    });
    mockModel(DocsReranker).thenReturn(replyWith('{"ranking":[27]}'));
    mockModel(MODEL_TOOL.agent).thenReturn(search, replyWith("done"));

    const result = await execute(app, MODEL_TOOL.start, { text: "on-call?" });

    const output = result.toolCalls[0]?.output as { results: readonly { source: string }[] };
    expect(output.results[0]?.source).toBe(ANSWER.source);
  });

  test("a code reranker calls no model: mockModel says so", ({ mockModel }) => {
    expect(() => mockModel(KeywordReranker)).toThrow(/a code reranker calls no model/u);
  });
});
