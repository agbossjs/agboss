import { Agent, DecidedBy, EmptyEnvironment, Workflow } from "../../../src/index.js";
import { WorkflowFinish, WorkflowStart, type Class } from "../../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import {
  Rag,
  RagMode,
  Reranker,
  RerankFailurePolicy,
  type RagConnector,
  type RagRetrieval,
  type RagRetrieveOptions,
  type RagReranking,
  type RerankerHandler,
} from "../../../src/rag/index.js";
import type { RagSearchResultDto } from "../../../src/dto/standard/framework.js";
import { MODEL_PROVIDERS } from "../../judges/fixtures/judged.workflow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";

/**
 * #703 — reranking: 30 candidates, the one that answers ranked 27th by the retriever. A model
 * reranker (scripted), a code reranker that finds it, one that fails, one that invents a passage —
 * each a knowledge base, read by an agent in tool mode and one in context mode.
 */

/** The passage that answers "when does on-call start?", 27th of the retrieval. */
export const ANSWER: RagSearchResultDto = {
  source: "oncall.md",
  text: "On-call starts after the third month.",
};

/** 30 candidates, `ANSWER` at index 26. */
export const CANDIDATES: readonly RagSearchResultDto[] = Array.from({ length: 30 }, (_, index) => ({
  source: index === 26 ? ANSWER.source : `near-miss-${String(index)}.md`,
  text: index === 26 ? ANSWER.text : `On-call rota detail ${String(index)}.`,
  score: 30 - index,
}));

/** A retriever giving the same 30 candidates to the default tenant, none to others. */
class Candidates implements RagConnector {
  readonly asked: number[] = [];

  retrieve(_query: string, options: RagRetrieveOptions): Promise<RagRetrieval> {
    this.asked.push(options.topK);
    const results = options.tenantId === "default" ? CANDIDATES.slice(0, options.topK) : [];
    return Promise.resolve({ results, costUsd: 0.0001 });
  }
}

@Reranker({ name: "docs-reranker", description: "Reranks on a model", model: "local/llama" })
export class DocsReranker {}

/** Finds the passage that names "third month" and puts it first. */
@Reranker({
  name: "keyword-reranker",
  description: "Reranks by a keyword",
  decidedBy: DecidedBy.Code,
})
export class KeywordReranker implements RerankerHandler {
  rerank(
    _q: string,
    candidates: readonly RagSearchResultDto[],
    options: { readonly keep: number },
  ): Promise<RagReranking> {
    const hits = candidates.filter((c) => c.text.includes("third month"));
    const rest = candidates.filter((c) => !c.text.includes("third month"));
    return Promise.resolve({ results: [...hits, ...rest].slice(0, options.keep), costUsd: 0.0004 });
  }
}

@Reranker({ name: "failing-reranker", description: "Always fails", decidedBy: DecidedBy.Code })
export class FailingReranker implements RerankerHandler {
  rerank(): Promise<RagReranking> {
    return Promise.reject(new Error("rerank API is down"));
  }
}

/** Puts a passage of its own first — what no reranker may do. */
@Reranker({
  name: "inventing-reranker",
  description: "Invents a passage",
  decidedBy: DecidedBy.Code,
})
export class InventingReranker implements RerankerHandler {
  rerank(_q: string, candidates: readonly RagSearchResultDto[]): Promise<RagReranking> {
    const invented = { source: "other-tenant/secret.md", text: "The vault code is plum." };
    return Promise.resolve({ results: [invented, ...candidates.slice(0, 2)] });
  }
}

const rerankOf = (by: Class, onFailure?: RerankFailurePolicy) => ({
  by,
  candidates: 30,
  keep: 3,
  ...(onFailure === undefined ? {} : { onFailure }),
});

@Rag({
  name: "model-ranked-rag",
  description: "Docs, model-reranked",
  rerank: rerankOf(DocsReranker),
})
export class ModelRankedRag extends Candidates {}

@Rag({
  name: "keyword-ranked-rag",
  description: "Docs, keyword-reranked",
  rerank: rerankOf(KeywordReranker),
})
export class KeywordRankedRag extends Candidates {}

@Rag({
  name: "fallback-ranked-rag",
  description: "Docs, failing reranker",
  rerank: rerankOf(FailingReranker),
})
export class FallbackRankedRag extends Candidates {}

@Rag({
  name: "strict-ranked-rag",
  description: "Docs, failing reranker, strict",
  rerank: rerankOf(FailingReranker, RerankFailurePolicy.FailStep),
})
export class StrictRankedRag extends Candidates {}

@Rag({
  name: "inventing-ranked-rag",
  description: "Docs, inventing reranker",
  rerank: rerankOf(InventingReranker),
})
export class InventingRankedRag extends Candidates {}

/** One workflow: a start, an agent reading `rag` in `mode`, a finish — all named `<name>-…`. */
function workflowWith(
  name: string,
  rag: Class,
  mode: RagMode,
): { workflow: Class; start: Class; agent: Class } {
  @Agent({
    name: `${name}-agent`,
    description: "Answers",
    prompt: "Answer from the docs.",
    model: "local/llama",
    rag: [{ use: rag, mode }],
  })
  class ReaderAgent {}
  @WorkflowStart({
    name: `${name}-workflow-start`,
    description: "A question",
    input: WorkflowStartTextDto,
  })
  class Start {}
  @WorkflowFinish({
    name: `${name}-workflow-finish`,
    description: "The answer",
    output: WorkflowFinishTextDto,
  })
  class Finish {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [start(Start).returns(WorkflowStartTextDto).toAgent(ReaderAgent).toFinish(Finish)],
    defaults: { models: { temperature: 0 }, router: { model: "typesafe/jev-1.13" } },
  })
  class ReaderWorkflow {}
  return { workflow: ReaderWorkflow, start: Start, agent: ReaderAgent };
}

export const MODEL_TOOL = workflowWith("model-tool", ModelRankedRag, RagMode.Tool);
export const MODEL_CONTEXT = workflowWith("model-context", ModelRankedRag, RagMode.Context);
export const KEYWORD_TOOL = workflowWith("keyword-tool", KeywordRankedRag, RagMode.Tool);
export const FALLBACK_CONTEXT = workflowWith(
  "fallback-context",
  FallbackRankedRag,
  RagMode.Context,
);
export const STRICT_TOOL = workflowWith("strict-tool", StrictRankedRag, RagMode.Tool);
export const STRICT_CONTEXT = workflowWith("strict-context", StrictRankedRag, RagMode.Context);
export const INVENTING_CONTEXT = workflowWith(
  "inventing-context",
  InventingRankedRag,
  RagMode.Context,
);

/** The application of every reranking workflow, on the local model provider. */
export function rerankApplication(budgets: readonly Class[] = TEST_BUDGETS): Class {
  @Application({
    name: "rerank-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [
      MODEL_TOOL,
      MODEL_CONTEXT,
      KEYWORD_TOOL,
      FALLBACK_CONTEXT,
      STRICT_TOOL,
      STRICT_CONTEXT,
      INVENTING_CONTEXT,
    ].map((w) => w.workflow),
    providers: MODEL_PROVIDERS,
    budgets,
  })
  class RerankApplication {}
  return RerankApplication;
}
