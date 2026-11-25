// `agboss rag index` fixture (#268 AC12): two agents share one knowledge base that builds an index
// (a tenant's own), one of them reads a second that has none; a third is shared and builds one
import {
  Agent,
  Application,
  EmptyEnvironment,
  Workflow,
  inline,
  Ttl,
} from "../../../../agboss/src/index.js";
import {
  Rag,
  RagScope,
  RagSource,
  type RagIndexReport,
  type RagIndexOptions,
  type RagRetrieval,
} from "../../../../agboss/src/rag/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { starOf } from "../../../../agboss/tests/fixtures/test-flow/star.js";
import { testConfig, testDefaults } from "../../../../agboss/tests/helpers.js";
import { usd } from "@agboss/core/units";
import { TestModelProvider } from "../../../../agboss/src/testing/test-model-provider.js";

@Rag({
  name: "notes-rag",
  description: "Notes about companies",
  scope: RagScope.Tenant,
  topK: 2,
})
export class NotesRag extends RagSource {
  protected override retrieve(): RagRetrieval {
    return { results: [] };
  }

  // each scope its own index — another one has more documents here
  protected override index({ scopeId }: RagIndexOptions): RagIndexReport {
    const documents = scopeId === "default" ? 2 : 7;
    return { documents, chunks: 3, skipped: 1, costUsd: usd(0.000_5) };
  }
}

@Rag({
  name: "handbook-rag",
  description: "The team handbook",
  scope: RagScope.Shared,
  topK: 2,
})
export class HandbookRag extends RagSource {
  protected override retrieve(): RagRetrieval {
    return { results: [] };
  }
}

@Rag({
  name: "guides-rag",
  description: "Guides every tenant reads",
  scope: RagScope.Shared,
  topK: 2,
})
export class GuidesRag extends RagSource {
  protected override retrieve(): RagRetrieval {
    return { results: [] };
  }

  // a shared corpus: built once, for no scope
  protected override index({ scopeId }: RagIndexOptions): RagIndexReport {
    return { documents: scopeId === undefined ? 4 : 99, chunks: 5, skipped: 0 };
  }
}

@Agent({
  name: "reader-agent",
  description: "Reads notes and the handbook",
  prompt: inline("Read."),
  model: "test/alpha",
  rag: [NotesRag, HandbookRag],
})
export class ReaderAgent {}

@Agent({
  name: "writer-agent",
  description: "Writes from the notes",
  prompt: inline("Write."),
  model: "test/beta",
  rag: [NotesRag, GuidesRag],
})
export class WriterAgent {}

@Workflow({
  name: "notes-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  defaults: testDefaults,
  flow: starOf(ReaderAgent, WriterAgent),
})
export class NotesWorkflow {}

/** The application `agboss rag index --application` indexes. */
@Application({
  modelProvider: TestModelProvider,
  name: "notes-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [NotesWorkflow],
  budgets: TEST_BUDGETS,
})
export class NotesApplication {}
