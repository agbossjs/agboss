// `agboss rag index` interrupted in its write phase (#891 D1): a real SqliteFtsRagSource over the folder and file the test names
import {
  Agent,
  Application,
  EmptyEnvironment,
  Workflow,
  inline,
  Ttl,
} from "../../../../agboss/src/index.js";
import { Rag, RagScope, SqliteFtsRagSource } from "../../../../agboss/src/rag/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { starOf } from "../../../../agboss/tests/fixtures/test-flow/star.js";
import { testConfig, testDefaults } from "../../../../agboss/tests/helpers.js";

@Rag({
  name: "write-rag",
  description: "A real index over the folder the test fills",
  scope: RagScope.Shared,
  topK: 2,
})
export class WriteRag extends SqliteFtsRagSource {
  constructor() {
    super({
      directory: process.env.RAG_WRITE_FOLDER ?? "",
      path: process.env.RAG_WRITE_SQLITE ?? "",
    });
  }
}

@Agent({
  name: "write-reader-agent",
  description: "Reads the knowledge base",
  prompt: inline("Read."),
  model: "test/alpha",
  price: testConfig.agents.alpha.price,
  rag: [WriteRag],
})
export class WriteReaderAgent {}

@Workflow({
  name: "write-notes-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  defaults: testDefaults,
  flow: starOf(WriteReaderAgent),
})
export class WriteNotesWorkflow {}

@Application({
  name: "write-notes-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [WriteNotesWorkflow],
  budgets: TEST_BUDGETS,
})
export class WriteNotesApplication {}
