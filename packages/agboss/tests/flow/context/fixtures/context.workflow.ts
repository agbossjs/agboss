import { Text, WorkflowStartTextDto, optional } from "../../../../src/dto/index.js";
import {
  Action,
  Agent,
  DecidedBy,
  ExecutionContext,
  Injectable,
  Judge,
  JudgeModel,
  JudgeVerdict,
  Router,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type JudgeHandler,
  type JudgeInput,
  type StepDescriptor,
  type ToolHandler,
  type WorkflowDescriptor,
} from "../../../../src/index.js";
import { agent, route, start } from "../../../helpers/flow.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { EmptyEnvironment } from "../../../../src/index.js";

/** What the components read of their execution, in order (reset by `resetSeen`). */
export const seen = {
  /** `step` of every tool call, as the tool read it. */
  toolSteps: [] as StepDescriptor[],
  /** `step` of every action run. */
  actionSteps: [] as StepDescriptor[],
  /** `workflow` as each action run read it. */
  workflows: [] as WorkflowDescriptor[],
  /** What `executionOf` gave inside the workflow: this execution, then another workflow's. */
  executionOf: [] as (string | undefined)[],
  /** The tree as an action read it: parent, root is itself, depth. */
  tree: [] as { readonly parent: unknown; readonly rootIsSelf: boolean; readonly depth: number }[],
  /** Reads a tool left running after it returned (a stray promise): what each one got. */
  strays: [] as Promise<unknown>[],
  /** The judges' verdicts in order: the first rejects, the rest pass. */
  judged: [] as string[],
};

export function resetSeen(): void {
  seen.toolSteps.length = 0;
  seen.actionSteps.length = 0;
  seen.workflows.length = 0;
  seen.executionOf.length = 0;
  seen.tree.length = 0;
  seen.strays.length = 0;
  seen.judged.length = 0;
}

export class NoteDto {
  @Text({ prompt: "what to note" })
  text!: string;
}

export class DraftDto {
  @Text({ prompt: "the draft" })
  text!: string;
}

/** A tool reading its step; it leaves a read behind that runs after it returned. */
@Tool({
  name: "note-tool",
  description: "Takes a note",
  input: NoteDto,
  output: NoteDto,
  deps: [ExecutionContext],
})
export class NoteTool implements ToolHandler<NoteDto, NoteDto> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run(input: NoteDto): Promise<NoteDto> {
    seen.toolSteps.push(this.executionContext.step);
    // a forgotten promise: it reads the context once the call has ended
    seen.strays.push(
      new Promise<unknown>((resolve) => {
        setImmediate(() => {
          try {
            resolve(this.executionContext.step);
          } catch (error) {
            resolve(error);
          }
        });
      }),
    );
    return Promise.resolve(input);
  }
}

/** Rejects the first reply, passes the rest: the agent retries within the same visit. */
@Judge({
  name: "picky",
  model: "test/picky",
  reply: DraftDto,
  deps: [JudgeModel, ExecutionContext],
})
export class PickyJudge implements JudgeHandler<DraftDto> {
  constructor(
    private readonly judgeModel: JudgeModel,
    private readonly executionContext: ExecutionContext,
  ) {}

  judge({ attempt }: JudgeInput<DraftDto>): Promise<JudgeVerdict> {
    seen.judged.push(
      `${this.judgeModel.model}:${this.executionContext.step.nodeId}:${String(attempt)}`,
    );
    return Promise.resolve(
      attempt === 0 ? JudgeVerdict.failed({ reason: "again" }) : JudgeVerdict.passed(),
    );
  }
}

const writer = {
  description: "Writes the draft with notes",
  prompt: "Write the draft.",
  model: "test/writer",
  price: { inputPerMTok: 1, outputPerMTok: 2 },
  maxVisits: 3,
  tools: [NoteTool],
  input: { message: WorkflowStartTextDto, draft: optional(DraftDto) },
  output: DraftDto,
} as const;

@Agent({ name: "writer-agent", ...writer })
export class WriterAgent {}

@Agent({
  name: "judged-writer-agent",
  ...writer,
  input: { message: WorkflowStartTextDto },
  judges: [PickyJudge],
  maxRetries: 1,
})
export class JudgedWriterAgent {}

/** Another workflow: `executionOf(Other)` inside `context-workflow` is `undefined`. */
@Workflow({ name: "other-workflow", version: "1.0.0", flow: [] })
export class OtherWorkflow {}

/** Reads its step and the execution tree; the workflow it runs in is found with `executionOf`. */
@Action({
  name: "publish-action",
  description: "Publishes the draft",
  input: { draft: DraftDto },
  output: DraftDto,
  deps: [ExecutionContext],
})
export class PublishAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: { readonly draft: { readonly value: DraftDto } }): Promise<DraftDto> {
    const context = this.executionContext;
    seen.actionSteps.push(context.step);
    seen.workflows.push(context.workflow);
    seen.executionOf.push(
      context.executionOf(ContextWorkflow)?.executionId,
      context.executionOf(OtherWorkflow)?.executionId,
    );
    seen.tree.push({
      parent: context.parent,
      rootIsSelf: context.root === context,
      depth: context.depth,
    });
    return Promise.resolve(input.draft.value);
  }
}

@WorkflowStart({
  name: "context-workflow-start",
  description: "What to write",
  input: WorkflowStartTextDto,
})
export class ContextStart {}

@WorkflowFinish({ name: "published-workflow-finish", description: "The draft", output: DraftDto })
export class PublishedFinish {}

@Router({
  name: "review-router",
  description: "Sends the draft back or publishes it",
  decidedBy: DecidedBy.Model,
  prompt: "Is the draft good?",
  model: "typesafe/jev-1.13",
  input: { draft: DraftDto },
  maxVisits: 4,
  routes: [
    { prompt: "The draft needs another pass", target: WriterAgent },
    { prompt: "Publish it: the draft is good", target: PublishAction },
  ],
})
export class ReviewRouter {}

/** start → writer ⇄ review → publish → published. */
@Workflow({
  name: "context-workflow",
  version: "2.1.0",
  providers: [PublishAction],
  flow: [
    start(ContextStart)
      .returns(WorkflowStartTextDto)
      .toAgent(WriterAgent),
    agent(WriterAgent)
      .returns(DraftDto)
      .toRouter(ReviewRouter)
      .chooseOne(
        route(WriterAgent),
        route(PublishAction)
          .returns(DraftDto)
          .toFinish(PublishedFinish),
      ),
  ],
})
export class ContextWorkflow {}

@Application({
  name: "context-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ContextWorkflow],
  budgets: TEST_BUDGETS,
})
export class ContextApplication {}

/** start → judged writer → published: one visit, a judge's retry inside it. */
@Workflow({
  name: "judged-context-workflow",
  version: "1.0.0",
  defaults: { router: { model: "typesafe/jev-1.13" } },
  flow: [
    start(ContextStart)
      .returns(WorkflowStartTextDto)
      .toAgent(JudgedWriterAgent)
      .returns(DraftDto)
      .toFinish(PublishedFinish),
  ],
})
export class JudgedContextWorkflow {}

@Application({
  name: "judged-context-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [JudgedContextWorkflow],
  budgets: TEST_BUDGETS,
})
export class JudgedContextApplication {}

/** Reads the context in its constructor — at application start, outside any execution. */
@Injectable({ deps: [ExecutionContext] })
export class EagerAuditService {
  readonly executionId: string;

  constructor(executionContext: ExecutionContext) {
    this.executionId = executionContext.executionId;
  }
}

/** Injects the context and reads it only when called: always allowed. */
@Injectable({ deps: [ExecutionContext] })
export class LazyAuditService {
  constructor(readonly executionContext: ExecutionContext) {}
}

@Agent({
  name: "quick-writer-agent",
  description: "Writes a draft",
  prompt: "Write the draft.",
  model: "test/writer",
  price: { inputPerMTok: 1, outputPerMTok: 2 },
  input: { message: WorkflowStartTextDto },
  output: DraftDto,
})
export class QuickWriterAgent {}

/** A workflow whose provider injects the context and reads it only when called. */
@Workflow({
  name: "audit-workflow",
  version: "1.0.0",
  providers: [LazyAuditService],
  flow: [
    start(ContextStart)
      .returns(WorkflowStartTextDto)
      .toAgent(QuickWriterAgent)
      .returns(DraftDto)
      .toFinish(PublishedFinish),
  ],
})
export class AuditWorkflow {}

@Application({
  name: "audit-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [AuditWorkflow],
  budgets: TEST_BUDGETS,
})
export class AuditApplication {}

/** A workflow whose provider reads the context in its constructor: created at start, it fails. */
@Workflow({
  name: "eager-audit-workflow",
  version: "1.0.0",
  providers: [EagerAuditService],
  flow: [
    start(ContextStart)
      .returns(WorkflowStartTextDto)
      .toAgent(QuickWriterAgent)
      .returns(DraftDto)
      .toFinish(PublishedFinish),
  ],
})
export class EagerAuditWorkflow {}

@Application({
  name: "eager-audit-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [EagerAuditWorkflow],
  budgets: TEST_BUDGETS,
})
export class EagerAuditApplication {}
