/** A judged text agent served over A2A (#1004, #1006): `a2aServer(listener)` streams its answers. */
import { Injectable } from "../../src/components/decorators.js";
import { A2AExpose, A2ACallerResolution, type A2ACallerResolver } from "../../src/a2a/index.js";
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
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { start } from "../helpers/flow.js";
import { DEFAULTS, MODEL_PROVIDERS } from "../judges/fixtures/judged.workflow.js";

@Judge({ name: "a2a-audit-judge", model: "local/judge", reply: PlainTextDto, deps: [JudgeModel] })
export class A2AJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}
  async judge({ reply }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const said = await this.judgeModel.invoke(`RUBRIC ${reply.text}`);
    return said.startsWith("PASS") ? JudgeVerdict.passed() : JudgeVerdict.failed({ reason: "no" });
  }
}

@Agent({
  name: "a2a-audit-agent",
  prompt: "Write.",
  description: "Writes",
  model: "local/llama",
  judges: [A2AJudge],
  maxRetries: 1,
})
export class A2AWriter {}

@WorkflowStart({ name: "a2a-audit-workflow-start", description: "Q", input: WorkflowStartTextDto })
class A2AStart {}

@WorkflowFinish({
  name: "a2a-audit-workflow-finish",
  description: "A",
  output: WorkflowFinishTextDto,
})
class A2AFinish {}

@Injectable()
export class AuditCallerResolver implements A2ACallerResolver<typeof A2AStart> {
  resolveCaller(): A2ACallerResolution<typeof A2AStart> {
    return A2ACallerResolution.resolved({});
  }
}

@Workflow({
  name: "a2a-audit-workflow",
  version: "1.0.0",
  flow: [start(A2AStart).returns(WorkflowStartTextDto).toAgent(A2AWriter).toFinish(A2AFinish)],
  defaults: DEFAULTS,
  providers: [AuditCallerResolver],
})
class A2AWorkflow {}

@A2AExpose({
  name: "a2a-audit-a2a-expose",
  description: "Served",
  version: "1.0.0",
  exports: [A2AStart],
})
export class AuditA2AExpose {}

@Application({
  name: "a2a-audit-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [A2AWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
  exposes: [AuditA2AExpose],
})
export class A2AJudgedApplication {}

export const judgedListener = { expose: AuditA2AExpose, callerResolver: AuditCallerResolver };
