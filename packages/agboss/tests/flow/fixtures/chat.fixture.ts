import { onRouter, onStart, toAgent, toFinish, toRouter } from "../../../src/flow/builder.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { oneOf, optional } from "../../../src/flow/dto-wrappers.js";
import { OpeningsDto, ProfileDto, ResumeMissingDto, WorkflowStartTextDto } from "./dtos.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "./budgets.js";
import { EmptyEnvironment, inline, Ttl } from "../../../src/index.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/** #272 example 1 — chat: a router in a loop. */

@WorkflowStart({
  name: "intake-workflow-start",
  description: "A customer's message",
  input: WorkflowStartTextDto,
})
export class IntakeWorkflowStart {}

@Agent({
  name: "profiler-agent",
  description: "Reads the resume into a profile",
  prompt: inline("Read the resume."),
  model: "moonshotai/kimi-k2.6",
  input: {
    message: WorkflowStartTextDto,
  },
  output: oneOf(ProfileDto, ResumeMissingDto),
})
export class ProfilerAgent {}

@Agent({
  name: "scout-agent",
  description: "Finds openings for the profile",
  prompt: inline("Find openings."),
  model: "moonshotai/kimi-k2.6",
  input: {
    // the router may route to the scout before the profiler ran (#270 [input.missing-on-path])
    profile: optional(ProfileDto),
  },
  output: OpeningsDto,
})
export class ScoutAgent {}

@WorkflowFinish({
  name: "ask-resume-workflow-finish",
  description: "Asks the customer for a resume",
  output: ResumeMissingDto,
})
export class AskResumeWorkflowFinish {}

@WorkflowFinish({
  name: "chat-workflow-finish",
  description: "The openings found",
  output: OpeningsDto,
})
export class ChatWorkflowFinish {}

@WorkflowFinish({
  name: "no-reply-workflow-finish",
  description: "Ends without a reply",
  output: WorkflowStartTextDto,
})
export class NoReplyWorkflowFinish {}

@Router({
  name: "main-router",
  description: "Sends the message to the step that handles it, or ends the execution",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: inline("Pick who handles the customer's message next."),
  input: {
    message: WorkflowStartTextDto,
  },
  maxVisits: 3,
  routes: [
    { target: ProfilerAgent, prompt: "The customer sends or changes their resume" },
    { target: ScoutAgent, prompt: "The customer asks for job openings" },
    { target: NoReplyWorkflowFinish, prompt: "Stop without a reply: the message needs no answer" },
  ],
})
export class MainRouter {}

export const chatPaths = [
  onStart(IntakeWorkflowStart).toRouter(MainRouter),

  onRouter(MainRouter)
    .onRoute(
      toAgent(ProfilerAgent).toOneOf([toRouter(MainRouter), toFinish(AskResumeWorkflowFinish)]),
    )
    .onRoute(toAgent(ScoutAgent).toFinish(ChatWorkflowFinish))
    .onRoute(toFinish(NoReplyWorkflowFinish)),
] as const;

@Workflow({
  name: "chat-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: chatPaths,
})
export class ChatWorkflow {}

@Application({
  name: "chat-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChatWorkflow],
  budgets: TEST_BUDGETS,
})
export class ChatApplication {}
