import { WorkflowStartTextDto, WorkflowFinishTextDto } from "../../../src/dto/index.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { FlowPath } from "../../../src/flow/ast.js";
import { onStart, toAgent, toFinish } from "../../helpers/flow.js";
import { inline } from "../../../src/index.js";
import { usd } from "../../../src/units/index.js";

@WorkflowStart({
  name: "chat-workflow-start",
  description: "A message from the user",
  input: WorkflowStartTextDto,
})
export class TestChat {}

/** A text agent: reads the message, answers with text. */
@Agent({
  name: "alpha-agent",
  description: "Handles alpha work",
  prompt: inline("You are alpha."),
  model: "test/alpha",
})
export class Alpha {}

@Agent({
  name: "beta-agent",
  description: "Handles beta work",
  prompt: inline("You are beta."),
  model: "test/beta",
})
export class Beta {}

@WorkflowFinish({
  name: "answer-workflow-finish",
  description: "The answer to the user",
  output: WorkflowFinishTextDto,
})
export class TestAnswer {}

@WorkflowFinish({
  name: "no-answer-workflow-finish",
  description: "Ends without an answer",
  output: WorkflowStartTextDto,
})
export class NoAnswer {}

export const ROUTES = {
  alpha: "Handles alpha work",
  beta: "Handles beta work",
  answer: "Stop without an answer: nothing to do",
} as const;

/** The test workflows' main router: an LLM ("test/router") so tests script it with fake chat models. */
@Router({
  name: "main-router",
  description: "Sends the task to an agent, or ends",
  decidedBy: DecidedBy.Model,
  prompt: inline("Pick who handles the task."),
  model: "test/router",
  input: { message: WorkflowStartTextDto },
  maxVisits: 10,
  routes: [
    { prompt: ROUTES.alpha, target: Alpha },
    { prompt: ROUTES.beta, target: Beta },
    { prompt: ROUTES.answer, target: NoAnswer },
  ],
})
export class TestMain {}

/** The star: workflow start → main router → alpha / beta → the answer (or no answer). */
export const testPaths: readonly FlowPath[] = [
  onStart(TestChat)
    .toRouter(TestMain)
    .onRoute(
      toAgent(Alpha)
        .toFinish(TestAnswer),
    )
    .onRoute(
      toAgent(Beta)
        .toFinish(TestAnswer),
    )
    .onRoute(toFinish(NoAnswer)),
];
