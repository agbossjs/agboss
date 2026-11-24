import {
  Agent,
  EmptyEnvironment,
  Judge,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
} from "../../../src/index.js";
import {
  PlainTextDto,
  WorkflowFinishTextDto,
  WorkflowStartTextDto,
} from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import { onStart } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { DEFAULTS, MODEL_PROVIDERS } from "./judged.workflow.js";

/**
 * #1290 — declarative model judges: empty classes with a `prompt` (a file next to this one, or
 * `inline(…)`) and an optional `threshold`; a pass-or-fail one, a scored one, and a second pass-or-fail
 * one so a test can see the budget stop the gate between two judges.
 */

@Judge({
  name: "grounded-judge",
  description: "The reply is grounded in the task",
  output: PlainTextDto,
  prompt: "./grounded.prompt.md",
  model: "local/judge",
})
export class GroundedJudge {}

@Judge({
  name: "polite-judge",
  output: PlainTextDto,
  prompt: inline("The reply is polite."),
  model: "local/judge",
  threshold: 0.8,
})
export class PoliteJudge {}

@Judge({
  name: "short-judge",
  output: PlainTextDto,
  prompt: inline("The reply is short."),
  model: "local/judge",
})
export class ShortJudge {}

@Agent({
  name: "declared-writer-agent",
  prompt: inline("Write."),
  description: "Writes an answer, gated by declarative judges",
  model: "local/llama",
  judges: [GroundedJudge, PoliteJudge],
  maxRetries: 1,
})
export class DeclaredWriter {}

@Agent({
  name: "two-judges-agent",
  prompt: inline("Write."),
  description: "Gated by two declarative judges, in order",
  model: "local/llama",
  judges: [GroundedJudge, ShortJudge],
  maxRetries: 1,
})
export class TwoJudgesWriter {}

@WorkflowStart({
  name: "declared-workflow-start",
  description: "A task",
  input: WorkflowStartTextDto,
})
export class DeclaredStart {}

@WorkflowFinish({
  name: "declared-workflow-finish",
  description: "The reply",
  output: WorkflowFinishTextDto,
})
export class DeclaredFinish {}

@Workflow({
  name: "declared-desk-workflow",
  version: "1.0.0",
  flow: [onStart(DeclaredStart).toAgent(DeclaredWriter).toFinish(DeclaredFinish)],
  defaults: DEFAULTS,
})
export class DeclaredDesk {}

@Workflow({
  name: "two-judges-workflow",
  version: "1.0.0",
  flow: [onStart(DeclaredStart).toAgent(TwoJudgesWriter).toFinish(DeclaredFinish)],
  defaults: DEFAULTS,
})
export class TwoJudgesDesk {}

@Application({
  name: "declared-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DeclaredDesk],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class DeclaredDeskApplication {}

@Application({
  name: "two-judges-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [TwoJudgesDesk],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class TwoJudgesApplication {}
