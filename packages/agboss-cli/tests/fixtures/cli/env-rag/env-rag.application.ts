// `agboss rag index` fixture (#1324b): a knowledge base on `deps: [ragEnv]` with a variable that has no
// default — an unset one fails the command, a profile's `configureEnv` gives it
import {
  Agent,
  Application,
  defineEnv,
  env,
  Workflow,
  inline,
  Ttl,
} from "../../../../../agboss/src/index.js";
import type { InferEnv } from "../../../../../agboss/src/index.js";
import {
  Rag,
  RagScope,
  RagSource,
  type RagIndexOptions,
  type RagIndexReport,
  type RagRetrieval,
} from "../../../../../agboss/src/rag/index.js";
import { TEST_BUDGETS } from "../../../../../agboss/tests/flow/fixtures/budgets.js";
import { starOf } from "../../../../../agboss/tests/fixtures/test-flow/star.js";
import { testDefaults } from "../../../../../agboss/tests/helpers.js";
import { TestModelProvider } from "../../../../../agboss/src/testing/test-model-provider.js";

export const ragEnv = defineEnv({ docs: env("ENV_RAG_DOCS") });

@Rag({
  name: "env-rag",
  description: "Reads its folder from the environment",
  scope: RagScope.Shared,
  topK: 2,
  deps: [ragEnv],
})
export class EnvRag extends RagSource {
  constructor(private readonly config: InferEnv<typeof ragEnv>) {
    super();
  }

  protected override retrieve(): RagRetrieval {
    return { results: [] };
  }

  /** The number of documents is the folder's name length: the run shows which value it got. */
  protected override index(_options: RagIndexOptions): RagIndexReport {
    return { documents: this.config.docs.length, chunks: 1, skipped: 0 };
  }
}

@Agent({
  name: "env-reader-agent",
  description: "Reads",
  prompt: inline("Read."),
  model: "test/alpha",
  rag: [EnvRag],
})
export class EnvReaderAgent {}

@Workflow({
  name: "env-rag-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  defaults: testDefaults,
  flow: starOf(EnvReaderAgent),
})
export class EnvRagWorkflow {}

@Application({
  modelProvider: TestModelProvider,
  name: "env-rag-application",
  version: "1.0.0",
  workflows: [EnvRagWorkflow],
  budgets: TEST_BUDGETS,
})
export class EnvRagApplication {}
