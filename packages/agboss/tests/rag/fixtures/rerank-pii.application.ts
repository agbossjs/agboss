import { Agent, EmptyEnvironment, Workflow } from "../../../src/index.js";
import { WorkflowFinish, WorkflowStart, type Class } from "../../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import {
  Rag,
  RagMode,
  Reranker,
  type RagConnector,
  type RagRetrieval,
  type RagRetrieveOptions,
} from "../../../src/rag/index.js";
import type { RagSearchResultDto } from "../../../src/dto/standard/framework.js";
import { MODEL_PROVIDERS } from "../../judges/fixtures/judged.workflow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { CardPiiPolicy, ContactPiiPolicy, PII_KEY_VARIABLE } from "../../pii/pii.fixture.js";
import { ShopExecutionContext } from "../../pii/sensitive.fixture.js";

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

class Passages implements RagConnector {
  constructor(private readonly passages: readonly RagSearchResultDto[]) {}

  retrieve(_query: string, options: RagRetrieveOptions): Promise<RagRetrieval> {
    return Promise.resolve({ results: this.passages.slice(0, options.topK) });
  }
}

@Reranker({ name: "people-reranker", description: "Reranks on a model", model: "local/llama" })
export class PeopleReranker {}

@Rag({
  name: "people-rag",
  description: "Who to ask",
  rerank: { by: PeopleReranker, candidates: 3, keep: 3 },
})
export class PeopleRag extends Passages {
  constructor() {
    super(PEOPLE);
  }
}

@Rag({
  name: "cards-rag",
  description: "Payment notes",
  rerank: { by: PeopleReranker, candidates: 2, keep: 2 },
})
export class CardsRag extends Passages {
  constructor() {
    super([
      { source: "billing.md", text: `The test card is ${CARD}.` },
      { source: "rota.md", text: "On-call starts after the third month." },
    ]);
  }
}

/** One workflow: a start, an agent with its own PII policies reading `rag` in `mode`, a finish. */
function workflowWith(name: string, rag: Class, mode: RagMode): { workflow: Class; start: Class } {
  @Agent({
    name: `${name}-agent`,
    description: "Answers",
    prompt: "Answer from the docs.",
    model: "local/llama",
    rag: [{ use: rag, mode }],
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
    version: "1.0.0",
    flow: [start(Start).returns(WorkflowStartTextDto).toAgent(ReaderAgent).toFinish(Finish)],
    defaults: { models: { temperature: 0 }, router: { model: "typesafe/jev-1.13" } },
  })
  class ReaderWorkflow {}
  return { workflow: ReaderWorkflow, start: Start };
}

export const PEOPLE_TOOL = workflowWith("people-tool", PeopleRag, RagMode.Tool);
export const PEOPLE_CONTEXT = workflowWith("people-context", PeopleRag, RagMode.Context);
export const CARDS_TOOL = workflowWith("cards-tool", CardsRag, RagMode.Tool);
export const CARDS_CONTEXT = workflowWith("cards-context", CardsRag, RagMode.Context);

/** The application: no PII policies of its own — the agents' policies are the only ones. */
@Application({
  name: "rerank-pii-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  executionContext: ShopExecutionContext,
  workflows: [PEOPLE_TOOL, PEOPLE_CONTEXT, CARDS_TOOL, CARDS_CONTEXT].map((w) => w.workflow),
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class RerankPiiApplication {}

export { PII_KEY_VARIABLE };
