/**
 * #703 AC1 — the core's LLM reranker: the model names candidates by number; numbers out of range or
 * repeated are dropped, the unranked follow in retrieval order, `keep` cut; a reply with no ranking
 * is a failure that keeps the call's spend; the reranker is a subset of the candidates, never more.
 */
import { AIMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it } from "vitest";
import {
  modelRerankerOf,
  rankedCandidates,
  rankingOf,
  RerankReplyError,
} from "../../src/rag/llm-reranker.js";
import type { ModelBinding } from "../../src/llm/registry.js";

const candidates = ["a", "b", "c", "d"].map((name) => ({ source: `${name}.md`, text: name }));
const options = { keep: 3, tenantId: "default", signal: new AbortController().signal };
const bindingOf = (reply: string): ModelBinding => ({
  model: new FakeListChatModel({ responses: [reply] }),
  settings: {
    model: "test/reranker",
    temperature: 0,
    maxTokens: 256,
    price: { inputPerMTok: 1, outputPerMTok: 2 },
  },
});

describe("#703: the LLM reranker's reply", () => {
  it("rankingOf: the numbers in range, each once; JSON around prose; none → undefined", () => {
    expect(rankingOf('Here: {"ranking":[3,3,9,0,1,2.5]}', 4)).toEqual([3, 1]);
    expect(rankingOf('{"ranking":[]}', 4)).toEqual([]);
    expect(rankingOf("no json", 4)).toBeUndefined();
    expect(rankingOf('{"order":[1]}', 4)).toBeUndefined();
    expect(rankingOf("{not json}", 4)).toBeUndefined();
  });

  it("rankedCandidates: the ranked first, the rest in retrieval order, keep of them, scored best first", () => {
    const ranked = rankedCandidates(candidates, [4, 2], 3);

    expect(ranked.map((c) => c.source)).toEqual(["d.md", "b.md", "a.md"]);
    expect(ranked.map((c) => c.score)).toEqual([1, 2 / 3, 1 / 3]);
  });

  it("one call: the reranked keep, the call's usage under reranker:<name>", async () => {
    const reranker = modelRerankerOf("docs-reranker", bindingOf('{"ranking":[3]}'));

    const reranking = await reranker.rerank("q", candidates, options);

    expect(reranking.results.map((c) => c.source)).toEqual(["c.md", "a.md", "b.md"]);
  });

  it("a reply with no ranking: RerankReplyError, its spend kept", async () => {
    const reranker = modelRerankerOf("docs-reranker", bindingOf("I cannot rank these."));

    const failed = await reranker.rerank("q", candidates, options).catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(RerankReplyError);
    expect((failed as RerankReplyError).usage[0]).toMatchObject({
      caller: "reranker:docs-reranker",
    });
  });

  it("the model reads the query and the numbered candidates", async () => {
    const model = new FakeListChatModel({ responses: ['{"ranking":[1]}'] });
    const seen: string[] = [];
    const spying = Object.assign(model, {
      invoke: async (...args: Parameters<typeof model.invoke>) => {
        seen.push(JSON.stringify(args[0]));
        return Promise.resolve(new AIMessage('{"ranking":[1]}'));
      },
    });
    const reranker = modelRerankerOf("docs-reranker", {
      model: spying,
      settings: {
        model: "test/reranker",
        temperature: 0,
        maxTokens: 256,
        price: { inputPerMTok: 1, outputPerMTok: 2 },
      },
    });

    await reranker.rerank("when?", candidates, options);

    expect(seen[0]).toContain("Query: when?");
    expect(seen[0]).toContain("[2] (b.md) b");
  });
});
