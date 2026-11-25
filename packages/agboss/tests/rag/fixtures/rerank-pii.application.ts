import { Agent, EmptyEnvironment, Tool, Workflow, inline, Ttl } from "../../../src/index.js";
import { WorkflowFinish, WorkflowStart, type Class } from "../../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import {
  Rag,
  RagQueryDto,
  RagReranker,
  RagScope,
  RagSearchResultsDto,
  RagSource,
  type RagRetrieval,
  type RagRetrieveOptions,
  type RagSearchResultDto,
} from "../../../src/rag/index.js";
import { ragMeta } from "../../../src/components/rag.js";
import { MODEL_PROVIDERS } from "../../judges/fixtures/judged.workflow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart } from "../../helpers/flow.js";
import { CardPiiPolicy, ContactPiiPolicy, PII_KEY_VARIABLE } from "../../pii/pii.fixture.js";
import { ShopExecutionContext } from "../../pii/sensitive.fixture.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #708 — a knowledge base whose candidates hold PII, reranked by the core's LLM reranker, read by
 * agents whose own PII policies (not the application's) hide contacts and refuse card numbers — in
 * tool and in context mode. One candidate holds an e-mail address, in its text and its source; one
 * the execution's sensitive user id; a second knowledge base holds a card number.
 */

export const EMAIL = "alice@example.com";
export const USER_ID = "user-7731";
export const CARD = "4242 4242 4242 4242";

/** Three candidates: an address in the first's text and source, the user id in the second. */
export const PEOPLE: readonly RagSearchResultDto[] = [
  { source: `people/${EMAIL}.md`, text: `Write to ${EMAIL} for on-call swaps.` },
  { source: "accounts.md", text: `The account ${USER_ID} owns the rota.` },
  { source: "rota.md", text: "On-call starts after the third month." },
];

class Passages extends RagSource {
  constructor(private readonly passages: readonly RagSearchResultDto[]) {
    super();
  }

  protected override retrieve(_query: string, options: RagRetrieveOptions): RagRetrieval {
    return { results: this.passages.slice(0, options.topK) };
  }
}

@RagReranker({
  name: "people-reranker",
  description: "Reranks on a model",
  candidates: 3,
  model: "local/llama",
})
export class PeopleReranker {}

@RagReranker({
  name: "cards-reranker",
  description: "Reranks on a model",
  candidates: 2,
  model: "local/llama",
})
export class CardsReranker {}

@Rag({
  name: "people-rag",
  description: "Who to ask",
  scope: RagScope.Tenant,
  topK: 3,
  reranker: PeopleReranker,
})
export class PeopleRag extends Passages {
  constructor() {
    super(PEOPLE);
  }
}

@Rag({
  name: "cards-rag",
  description: "Payment notes",
  scope: RagScope.Tenant,
  topK: 2,
  reranker: CardsReranker,
})
export class CardsRag extends Passages {
  constructor() {
    super([
      { source: "billing.md", text: `The test card is ${CARD}.` },
      { source: "rota.md", text: "On-call starts after the third month." },
    ]);
  }
}

/** One workflow: a start, an agent with its own PII policies reading `rag` as `mode`, a finish. */
function workflowWith(
  name: string,
  rag: Class<Passages>,
  mode: "tool" | "context",
): { workflow: Class; start: Class } {
  @Tool({
    name: `search-${ragMeta(rag).name}-tool`,
    description: "Searches the docs",
    input: RagQueryDto,
    output: RagSearchResultsDto,
    readOnly: true,
    deps: [rag],
  })
  class SearchTool {
    constructor(private readonly docs: Passages) {}

    execute({ query }: RagQueryDto): Promise<RagSearchResultsDto> {
      return this.docs.search(query);
    }
  }
  @Agent({
    name: `${name}-agent`,
    description: "Answers",
    prompt: inline("Answer from the docs."),
    model: "local/llama",
    ...(mode === "tool" ? { tools: [SearchTool] } : { rag: [rag] }),
    piiPolicies: [ContactPiiPolicy, CardPiiPolicy],
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
    modelProvider: TestModelProvider,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [onStart(Start).toAgent(ReaderAgent).toFinish(Finish)],
    defaults: { models: { temperature: 0 }, router: { model: "typesafe/jev-1.13" } },
    providers: [rag, SearchTool],
  })
  class ReaderWorkflow {}
  return { workflow: ReaderWorkflow, start: Start };
}

export const PEOPLE_TOOL = workflowWith("people-tool", PeopleRag, "tool");
export const PEOPLE_CONTEXT = workflowWith("people-context", PeopleRag, "context");
export const CARDS_TOOL = workflowWith("cards-tool", CardsRag, "tool");
export const CARDS_CONTEXT = workflowWith("cards-context", CardsRag, "context");

/** The application: no PII policies of its own — the agents' policies are the only ones. */
@Application({
  name: "rerank-pii-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  executionContext: ShopExecutionContext,
  workflows: [PEOPLE_TOOL, PEOPLE_CONTEXT, CARDS_TOOL, CARDS_CONTEXT].map((w) => w.workflow),
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class RerankPiiApplication {}

export { PII_KEY_VARIABLE };
