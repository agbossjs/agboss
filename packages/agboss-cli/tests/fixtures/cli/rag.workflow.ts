// `agboss rag index` fixture (#268 AC12): two agents share one knowledge base that builds an index,
// one of them reads a second that has none
import { Agent, Application, EmptyEnvironment, Workflow } from "../../../../agboss/src/index.js";
import {
  Rag,
  RagMode,
  type IndexReport,
  type RagConnector,
  type RagRetrieval,
} from "../../../../agboss/src/rag/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { starOf } from "../../../../agboss/tests/fixtures/test-flow/star.js";
import { testConfig, testDefaults } from "../../../../agboss/tests/helpers.js";

@Rag({ name: "notes-rag", description: "Notes about companies", topK: 2 })
export class NotesRag implements RagConnector {
  retrieve(): Promise<RagRetrieval> {
    return Promise.resolve({ results: [] });
  }

  index(): Promise<IndexReport> {
    return Promise.resolve({ documents: 2, chunks: 3, skipped: 1, costUsd: 0.000_5 });
  }
}

@Rag({ name: "handbook-rag", description: "The team handbook", topK: 2 })
export class HandbookRag implements RagConnector {
  retrieve(): Promise<RagRetrieval> {
    return Promise.resolve({ results: [] });
  }
}

@Agent({
  name: "reader-agent",
  description: "Reads notes and the handbook",
  prompt: "Read.",
  model: "test/alpha",
  price: testConfig.agents.alpha.price,
  rag: [
    { use: NotesRag, mode: RagMode.Tool },
    { use: HandbookRag, mode: RagMode.Tool },
  ],
})
export class ReaderAgent {}

@Agent({
  name: "writer-agent",
  description: "Writes from the notes",
  prompt: "Write.",
  model: "test/beta",
  price: testConfig.agents.alpha.price,
  rag: [{ use: NotesRag, mode: RagMode.Context }],
})
export class WriterAgent {}

@Workflow({
  name: "notes-workflow",
  version: "1.0.0",
  defaults: testDefaults,
  flow: starOf(ReaderAgent, WriterAgent),
})
export class NotesWorkflow {}

/** The application `agboss rag index --application` indexes. */
@Application({
  name: "notes-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [NotesWorkflow],
  budgets: TEST_BUDGETS,
})
export class NotesApplication {}
