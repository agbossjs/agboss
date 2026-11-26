import { Application } from "../../../src/application/application.js";
import { Text, WorkflowFinishTextDto } from "../../../src/dto/index.js";
import {
  Agent,
  Judge,
  PiiAction,
  Ttl,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
} from "../../../src/index.js";
import { hours } from "../../../src/units/index.js";
import { ContactPiiPolicy } from "../../pii/pii.fixture.js";
import { onStart } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "./budgets.js";
import { EvalDeskModelProvider } from "./eval-desk.fixture.js";

/** #1301: a desk whose start DTO has `sensitive` fields, judged by a model judge in an eval suite. */

export class SensitiveMessageDto {
  @Text({ prompt: "the text the run starts with", minLength: 1 })
  text!: string;

  @Text({ prompt: "who sent it", optional: true, sensitive: PiiAction.mask() })
  author?: string;

  @Text({ prompt: "who reported it", optional: true, sensitive: PiiAction.tokenize() })
  reporter?: string;
}

@Agent({
  name: "judged-desk-agent",
  description: "Answers",
  prompt: inline("Answer."),
  model: "test/desk",
  input: { message: SensitiveMessageDto },
})
export class JudgedDeskAgent {}

@WorkflowStart({
  name: "judged-desk-workflow-start",
  description: "A message",
  input: SensitiveMessageDto,
})
export class JudgedDeskStart {}

@WorkflowFinish({
  name: "judged-desk-workflow-finish",
  description: "Answered",
  output: WorkflowFinishTextDto,
})
export class JudgedDeskFinish {}

@Workflow({
  name: "judged-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(JudgedDeskStart).toAgent(JudgedDeskAgent).toFinish(JudgedDeskFinish)],
})
export class JudgedDeskWorkflow {}

@Judge({
  name: "task-pii-judge",
  output: WorkflowFinishTextDto,
  prompt: inline("The reply answers the task."),
  model: "test/judge",
})
export class TaskPiiJudge {}

@Application({
  name: "judged-desk-application",
  modelProvider: EvalDeskModelProvider,
  providers: [EvalDeskModelProvider],
  version: "1.0.0",
  workflows: [JudgedDeskWorkflow],
  piiPolicies: [ContactPiiPolicy],
  retention: { executionRecords: hours(24) },
  budgets: TEST_BUDGETS,
})
export class JudgedDeskApplication {}
