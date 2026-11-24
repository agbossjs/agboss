/**
 * The custom compaction test applications (#382): a graph desk whose agent sees one turn in full and
 * whose `@Memory` has a `compact(input)` — `GraphMemory` hands every two turns
 * older than the window to a knowledge graph service (`deps`, created by the container) — behind a
 * PII policy; the same desk on another custom class of the same name (the hash), and a desk whose
 * custom compaction has no `compact` method (the rule).
 */
import {
  Agent,
  ExecutionContext,
  Injectable,
  Memory,
  PiiKind,
  PiiPolicy,
  Ttl,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type CompactionInput,
  type CompactionTurn,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import type { Class } from "../../src/components/injection.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../helpers/flow.js";

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

@Memory({
  name: "graph-memory",
  description: "Keeps the facts of old turns in a knowledge graph",
  ttl: Ttl.Forever,
  uncompactedTurns: 1,
  turnsBetweenCompactions: 2,
  deps: [KnowledgeGraphService, ExecutionContext],
})
export class GraphMemory {
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
@Memory({
  name: "graph-memory",
  description: "Keeps the facts of old turns in a knowledge graph",
  ttl: Ttl.Forever,
  uncompactedTurns: 1,
  turnsBetweenCompactions: 2,
})
export class OtherGraphMemory {
  compact(): readonly string[] {
    return ["one summary"];
  }
}

@PiiPolicy({
  name: "graph-contact-pii-policy",
  description: "Hides email addresses",
  rules: [PiiKind.Email.tokenize()],
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

/** The graph desk on a memory. */
export const graphDeskOn = (memory: Class, name: string): Class => {
  @Workflow({
    name: "graph-desk-workflow",
    version: "1.0.0",
    flow: [onStart(GraphStart).toAgent(GraphAgent).toFinish(GraphAnswer)],
    memory,
    providers: [KnowledgeGraphService],
  })
  class GraphDeskWorkflow {}

  @Application({
    name,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [GraphDeskWorkflow],
    piiPolicies: [GraphContactPiiPolicy],
    budgets: TEST_BUDGETS,
  })
  class GraphDeskApplication {}
  return GraphDeskApplication;
};

export const GraphDeskApplication = graphDeskOn(GraphMemory, "graph-desk-application");

export const OtherGraphDeskApplication = graphDeskOn(
  OtherGraphMemory,
  "other-graph-desk-application",
);
