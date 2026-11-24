/** A judged text agent served over A2A (#1004, #1006): `a2aServer(listener)` streams its answers. */
import { Injectable } from "../../src/components/decorators.js";
import { A2AExpose } from "../../src/a2a/index.js";
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
  inline,
} from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { PlainTextDto, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../helpers/flow.js";
import { DEFAULTS, MODEL_PROVIDERS } from "../judges/fixtures/judged.workflow.js";
import { HttpAuthResult, HttpAuthenticator } from "../../src/index.js";

@Judge({ name: "a2a-audit-judge", model: "local/judge", output: PlainTextDto, deps: [JudgeModel] })
export class A2AJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}
  async judge({ output }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const said = await this.judgeModel.invoke(`RUBRIC ${output.text}`);
    return said.startsWith("PASS") ? JudgeVerdict.passed() : JudgeVerdict.failed("no");
  }
}

@Agent({
  name: "a2a-audit-agent",
  prompt: inline("Write."),
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

@HttpAuthenticator()
export class AuditAuthenticator {
  authenticate(): HttpAuthResult {
    return HttpAuthResult.authenticated({});
  }
}

@Workflow({
  name: "a2a-audit-workflow",
  version: "1.0.0",
  flow: [onStart(A2AStart).toAgent(A2AWriter).toFinish(A2AFinish)],
  defaults: DEFAULTS,
  providers: [AuditAuthenticator],
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
  endpoints: [AuditA2AExpose],
})
export class A2AJudgedApplication {}

export const judgedListener = { endpoint: AuditA2AExpose, authenticator: AuditAuthenticator };
