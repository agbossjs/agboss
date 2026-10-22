/**
 * The custom compaction test applications (#382): a graph desk whose agent sees one turn in full and
 * whose `@Compaction` is `CompactionStrategy.Custom` — `GraphMemoryCompaction` hands every two turns
 * older than the window to a knowledge graph service (`deps`, created by the container) — behind a
 * PII policy; the same desk on another custom class of the same name (the hash), and a desk whose
 * custom compaction has no `compact` method (the rule).
 */
import {
  Agent,
  Compaction,
  CompactionStrategy,
  ExecutionContext,
  Injectable,
  PiiAction,
  PiiKind,
  PiiPolicy,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  pii,
  type CompactionHandler,
  type CompactionInput,
  type CompactionTurn,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import type { Class } from "../../src/components/injection.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { start } from "../helpers/flow.js";

/** A knowledge graph: keeps the facts, answers one summary per turn after the previous ones. */
@Injectable()
export class KnowledgeGraphService {
  saveFactsAndSummarize(
    _threadId: string,
    turns: readonly CompactionTurn[],
    previous: readonly string[],
  ): Promise<readonly string[]> {
    const facts = turns.map((turn) => `fact: ${JSON.stringify(turn.input)}`);
    return Promise.resolve([...previous, ...facts]);
  }
}

@Compaction({
  name: "graph-memory-compaction",
  description: "Keeps the facts of old turns in a knowledge graph",
  strategy: CompactionStrategy.Custom,
  turnsBetweenCompactions: 2,
  deps: [KnowledgeGraphService, ExecutionContext],
})
export class GraphMemoryCompaction implements CompactionHandler {
  constructor(
    private readonly knowledgeGraphService: KnowledgeGraphService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async compact(input: CompactionInput): Promise<readonly string[]> {
    return this.knowledgeGraphService.saveFactsAndSummarize(
      this.executionContext.threadId,
      input.turnsToCompact,
      input.previousSummaries,
    );
  }
}

/** Another class under the same name: the same settings, another `compact()`. */
@Compaction({
  name: "graph-memory-compaction",
  description: "Keeps the facts of old turns in a knowledge graph",
  strategy: CompactionStrategy.Custom,
  turnsBetweenCompactions: 2,
})
export class OtherGraphMemoryCompaction implements CompactionHandler {
  compact(): readonly string[] {
    return ["one summary"];
  }
}

@PiiPolicy({
  name: "graph-contact-pii-policy",
  description: "Hides email addresses",
  rules: [pii(PiiKind.Email, PiiAction.replaceWithToken())],
})
export class GraphContactPiiPolicy {}

@WorkflowStart({
  name: "graph-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class GraphStart {}

@WorkflowFinish({
  name: "graph-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class GraphAnswer {}

/** Sees contacts as they are: its model reads the stored summaries revealed. */
@Agent({
  name: "graph-agent",
  description: "Answers from the graph's summaries",
  prompt: "Answer the message.",
  model: "test/graph",
  excludePiiPolicies: [GraphContactPiiPolicy],
})
export class GraphAgent {}

@Workflow({
  name: "graph-desk-workflow",
  version: "1.0.0",
  flow: [start(GraphStart).returns(WorkflowStartTextDto).toAgent(GraphAgent).toFinish(GraphAnswer)],
  uncompactedTurns: 1,
  providers: [KnowledgeGraphService],
})
export class GraphDeskWorkflow {}

/** The graph desk on a compaction: its application's. */
export const graphDeskOn = (compaction: Class, name: string): Class => {
  @Application({
    name,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [GraphDeskWorkflow],
    piiPolicies: [GraphContactPiiPolicy],
    compaction,
    budgets: TEST_BUDGETS,
  })
  class GraphDeskApplication {}
  return GraphDeskApplication;
};

export const GraphDeskApplication = graphDeskOn(GraphMemoryCompaction, "graph-desk-application");

export const OtherGraphDeskApplication = graphDeskOn(
  OtherGraphMemoryCompaction,
  "other-graph-desk-application",
);
