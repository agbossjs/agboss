// `agboss rag index` interrupted in its write phase (#891 D1): a real SqliteFtsConnector over the folder and file the test names
import {
  Agent,
  Application,
  EmptyEnvironment,
  InjectionToken,
  provide,
  Workflow,
} from "../../../../agboss/src/index.js";
import {
  Rag,
  RagMode,
  RagTenancy,
  SqliteFtsConnector,
  type SqliteFtsOptions,
} from "../../../../agboss/src/rag/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { starOf } from "../../../../agboss/tests/fixtures/test-flow/star.js";
import { testConfig, testDefaults } from "../../../../agboss/tests/helpers.js";

export const WRITE_DOCS = new InjectionToken<SqliteFtsOptions>("WRITE_DOCS");

@Rag({
  name: "write-rag",
  description: "A real index over the folder the test fills",
  tenancy: RagTenancy.PerTenant,
  topK: 2,
  deps: [WRITE_DOCS],
})
export class WriteRag extends SqliteFtsConnector {}

@Agent({
  name: "write-reader-agent",
  description: "Reads the knowledge base",
  prompt: "Read.",
  model: "test/alpha",
  price: testConfig.agents.alpha.price,
  rag: [{ use: WriteRag, mode: RagMode.Tool }],
})
export class WriteReaderAgent {}

@Workflow({
  name: "write-notes-workflow",
  version: "1.0.0",
  defaults: testDefaults,
  flow: starOf(WriteReaderAgent),
  providers: [
    provide(WRITE_DOCS, {
      folder: process.env.RAG_WRITE_FOLDER ?? "",
      sqlitePath: process.env.RAG_WRITE_SQLITE ?? "",
    }),
  ],
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
