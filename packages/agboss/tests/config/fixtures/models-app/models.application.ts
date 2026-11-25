import { Application } from "../../../../src/application/application.js";
import { EmptyEnvironment } from "../../../../src/index.js";
import { MODEL_PROVIDERS } from "../../../judges/fixtures/judged.workflow.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { MODEL_TOOL } from "../../../rag/fixtures/rerank.application.js";
import { LocalModelProvider } from "../../../models/providers.fixture.js";

/** A workflow whose knowledge base is reranked by a model (`docs-reranker`, `local/llama`), on the local provider. */
@Application({
  name: "models-config-application",
  modelProvider: LocalModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [MODEL_TOOL.workflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class ModelsApplication {}
