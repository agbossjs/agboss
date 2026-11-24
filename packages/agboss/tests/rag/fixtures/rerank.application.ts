import { usd, Ttl } from "../../../src/units/index.js";
import { Agent, EmptyEnvironment, Tool, Workflow, inline } from "../../../src/index.js";
import {
  WorkflowFinish,
  WorkflowStart,
  type Class,
  type ExecutionObserver,
} from "../../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import {
  Rag,
  RagQueryDto,
  RagReranker,
  RagScope,
  RagSearchResultsDto,
  RagSource,
  RerankFailurePolicy,
  type RagRetrieval,
  type RagRetrieveOptions,
  type RagSearchResultDto,
  type RerankResult,
} from "../../../src/rag/index.js";
import { ragMeta } from "../../../src/components/rag.js";
import { MODEL_PROVIDERS } from "../../judges/fixtures/judged.workflow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart } from "../../helpers/flow.js";

/**
 * #703 — reranking: 30 candidates, the one that answers ranked 27th by the retriever. A model
 * reranker (scripted), a code reranker that finds it, one that fails, one that invents a passage —
 * each a knowledge base, read by an agent through a search tool and one through `rag: [...]`.
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
class Candidates extends RagSource {
  readonly asked: number[] = [];

  protected override retrieve(_query: string, options: RagRetrieveOptions): RagRetrieval {
    this.asked.push(options.topK);
    const results = options.scopeId === "default" ? CANDIDATES.slice(0, options.topK) : [];
    return { results, costUsd: usd(0.0001) };
  }
}

@RagReranker({
  name: "docs-reranker",
  description: "Reranks on a model",
  candidates: 30,
  model: "local/llama",
})
export class DocsReranker {}

/** Finds the passage that names "third month" and puts it first. */
@RagReranker({ name: "keyword-reranker", description: "Reranks by a keyword", candidates: 30 })
export class KeywordReranker {
  rerank(
    _q: string,
    candidates: readonly RagSearchResultDto[],
    options: { readonly topK: number },
  ): RerankResult {
    const hits = candidates.filter((c) => c.text.includes("third month"));
    const rest = candidates.filter((c) => !c.text.includes("third month"));
    return { results: [...hits, ...rest].slice(0, options.topK), costUsd: usd(0.0004) };
  }
}

/** Always fails; the default `onFailure` fails the step. */
@RagReranker({ name: "failing-reranker", description: "Always fails", candidates: 30 })
export class FailingReranker {
  rerank(): RerankResult {
    throw new Error("rerank API is down");
  }
}

/** Always fails, and the knowledge base says it may degrade. */
@RagReranker({
  name: "lenient-reranker",
  description: "Always fails, may degrade",
  candidates: 30,
  onFailure: RerankFailurePolicy.Fallback,
})
export class LenientReranker {
  rerank(): RerankResult {
    throw new Error("rerank API is down");
  }
}

/** Puts a passage of its own first — what no reranker may do. */
@RagReranker({
  name: "inventing-reranker",
  description: "Invents a passage",
  candidates: 30,
  onFailure: RerankFailurePolicy.Fallback,
})
export class InventingReranker {
  rerank(_q: string, candidates: readonly RagSearchResultDto[]): RerankResult {
    const invented = { source: "other-tenant/secret.md", text: "The vault code is plum." };
    return { results: [invented, ...candidates.slice(0, 2)] };
  }
}

@Rag({
  name: "model-ranked-rag",
  description: "Docs, model-reranked",
  scope: RagScope.Tenant,
  topK: 3,
  reranker: DocsReranker,
})
export class ModelRankedRag extends Candidates {}

@Rag({
  name: "keyword-ranked-rag",
  description: "Docs, keyword-reranked",
  scope: RagScope.Tenant,
  topK: 3,
  reranker: KeywordReranker,
})
export class KeywordRankedRag extends Candidates {}

@Rag({
  name: "fallback-ranked-rag",
  description: "Docs, failing reranker, may degrade",
  scope: RagScope.Tenant,
  topK: 3,
  reranker: LenientReranker,
})
export class FallbackRankedRag extends Candidates {}

@Rag({
  name: "strict-ranked-rag",
  description: "Docs, failing reranker, strict",
  scope: RagScope.Tenant,
  topK: 3,
  reranker: FailingReranker,
})
export class StrictRankedRag extends Candidates {}

@Rag({
  name: "inventing-ranked-rag",
  description: "Docs, inventing reranker",
  scope: RagScope.Tenant,
  topK: 3,
  reranker: InventingReranker,
})
export class InventingRankedRag extends Candidates {}

/** How an agent reads a knowledge base: it searches itself, or the passages come first. */
type Reading = "tool" | "context";

/** One workflow: a start, an agent reading `rag` as `reading`, a finish — all named `<name>-…`. */
function workflowWith(
  name: string,
  rag: Class<Candidates>,
  reading: Reading,
): { workflow: Class; start: Class; agent: Class; tool: Class } {
  @Tool({
    name: `search-${ragMeta(rag).name}-tool`,
    description: "Searches the docs",
    input: RagQueryDto,
    output: RagSearchResultsDto,
    readOnly: true,
    deps: [rag],
  })
  class SearchTool {
    constructor(private readonly docs: Candidates) {}

    execute({ query }: RagQueryDto): Promise<RagSearchResultsDto> {
      return this.docs.search(query);
    }
  }
  @Agent({
    name: `${name}-agent`,
    description: "Answers",
    prompt: inline("Answer from the docs."),
    model: "local/llama",
    ...(reading === "tool" ? { tools: [SearchTool] } : { rag: [rag] }),
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
    historyTtl: Ttl.Forever,
    flow: [onStart(Start).toAgent(ReaderAgent).toFinish(Finish)],
    defaults: { models: { temperature: 0 }, router: { model: "typesafe/jev-1.13" } },
    providers: [rag, SearchTool],
  })
  class ReaderWorkflow {}
  return { workflow: ReaderWorkflow, start: Start, agent: ReaderAgent, tool: SearchTool };
}

export const MODEL_TOOL = workflowWith("model-tool", ModelRankedRag, "tool");
export const MODEL_CONTEXT = workflowWith("model-context", ModelRankedRag, "context");
export const KEYWORD_TOOL = workflowWith("keyword-tool", KeywordRankedRag, "tool");
export const FALLBACK_CONTEXT = workflowWith("fallback-context", FallbackRankedRag, "context");
export const STRICT_TOOL = workflowWith("strict-tool", StrictRankedRag, "tool");
export const STRICT_CONTEXT = workflowWith("strict-context", StrictRankedRag, "context");
export const INVENTING_CONTEXT = workflowWith("inventing-context", InventingRankedRag, "context");

/** The application of every reranking workflow, on the local model provider. */
export function rerankApplication(
  budgets: readonly Class[] = TEST_BUDGETS,
  observers: readonly Class<ExecutionObserver>[] = [],
): Class {
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
    observers,
    budgets,
  })
  class RerankApplication {}
  return RerankApplication;
}
