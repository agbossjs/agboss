// `agboss rag index` fixture: an owner-scoped knowledge base — an owner id is unique within a tenant
// only, so the command names the tenant too
import { Agent, Application, EmptyEnvironment, Workflow, inline } from "../../../../agboss/src/index.js";
import {
  Rag,
  RagScope,
  RagSource,
  type RagIndexOptions,
  type RagIndexReport,
  type RagRetrieval,
} from "../../../../agboss/src/rag/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { starOf } from "../../../../agboss/tests/fixtures/test-flow/star.js";
import { testConfig, testDefaults } from "../../../../agboss/tests/helpers.js";

@Rag({ name: "owner-notes-rag", description: "An owner's notes", scope: RagScope.Owner, topK: 2 })
export class OwnerNotesRag extends RagSource {
  protected override retrieve(): RagRetrieval {
    return { results: [] };
  }

  // the documents say whose index was built: the tenant and the owner both
  protected override index({ tenantId, scopeId }: RagIndexOptions): RagIndexReport {
    return {
      documents: (tenantId ?? "").length * 100 + (scopeId ?? "").length,
      chunks: 1,
      skipped: 0,
    };
  }
}

@Agent({
  name: "owner-reader-agent",
  description: "Reads an owner's notes",
  prompt: inline("Read."),
  model: "test/alpha",
  price: testConfig.agents.alpha.price,
  rag: [OwnerNotesRag],
})
export class OwnerReaderAgent {}

@Workflow({
  name: "owner-notes-workflow",
  version: "1.0.0",
  defaults: testDefaults,
  flow: starOf(OwnerReaderAgent),
})
export class OwnerNotesWorkflow {}

@Application({
  name: "owner-notes-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [OwnerNotesWorkflow],
  budgets: TEST_BUDGETS,
})
export class OwnerNotesApplication {}
