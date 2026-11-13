/**
 * A text agent with a model judge and the contact PII policy: the application of the streaming
 * tests (#1004, #1006, #1007). The judge asks its own model, so it is an internal model call whose
 * text must never reach the user's stream.
 */
import {
  Agent,
  EmptyEnvironment,
  Judge,
  JudgeModel,
  JudgeVerdict,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type JudgeHandler,
  type JudgeInput,
} from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { PlainTextDto, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { start } from "../helpers/flow.js";
import { DEFAULTS, MODEL_PROVIDERS } from "../judges/fixtures/judged.workflow.js";
import { ContactPiiPolicy } from "../pii/pii.fixture.js";

/** What the judge's model is asked: it answers `PASS…` or `FAIL…`. */
@Judge({ name: "audit-judge", model: "local/judge", reply: PlainTextDto, deps: [JudgeModel] })
export class AuditJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ reply }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const said = await this.judgeModel.invoke(`INTERNAL RUBRIC. Is this fine? ${reply.text}`);
    return said.startsWith("PASS")
      ? JudgeVerdict.passed()
      : JudgeVerdict.failed({ reason: "not fine" });
  }
}

@Agent({
  name: "audit-writer-agent",
  prompt: "Write.",
  description: "Writes an answer",
  model: "local/llama",
  judges: [AuditJudge],
  maxRetries: 1,
  piiPolicies: [ContactPiiPolicy],
})
export class AuditWriter {}

@WorkflowStart({ name: "audit-workflow-start", description: "A task", input: WorkflowStartTextDto })
export class AuditStart {}

@WorkflowFinish({
  name: "audit-workflow-finish",
  description: "The reply",
  output: WorkflowFinishTextDto,
})
export class AuditFinish {}

@Workflow({
  name: "audit-workflow",
  version: "1.0.0",
  flow: [
    start(AuditStart).returns(WorkflowStartTextDto).toAgent(AuditWriter).toFinish(AuditFinish),
  ],
  defaults: DEFAULTS,
})
class AuditWorkflow {}

@Application({
  name: "audit-judge-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [AuditWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class AuditJudgeApplication {}

/** The text of every `textDelta`, in order. */
export const deltas = (events: readonly ExecutionStreamEvent[]): string[] =>
  events.flatMap((event) => (event.kind === "textDelta" ? [event.delta] : []));
