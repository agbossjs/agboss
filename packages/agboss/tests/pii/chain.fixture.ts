/**
 * #1150 — a child workflow under its ancestors' PII policies. The application masks e-mails
 * (`ContactPiiPolicy`); chain-root-workflow lists `RootSecretPiiPolicy` (ROOT-7731), its children
 * list `ChildSecretPiiPolicy` (CHILD-5512). Every child reads the root's start text as its own.
 */
import {
  Agent,
  ChildPlacement,
  DecidedBy,
  Observer,
  PiiAction,
  PiiPolicy,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type AgentEndEvent,
  type AgentStartEvent,
  type ExecutionEndEvent,
  type ExecutionStartEvent,
  type PiiMatch,
  type PiiPolicyHandler,
  inline,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { hours } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart, toAgent, toFinish } from "../helpers/flow.js";
import { ContactPiiPolicy } from "./pii.fixture.js";

export const ROOT_SECRET = "ROOT-7731";
export const CHILD_SECRET = "CHILD-5512";
export const EMAIL = "dana@acme.com";
/** The text every root starts with: one value of each policy. */
export const TEXT = `ticket ${ROOT_SECRET} for ${CHILD_SECRET}, mail ${EMAIL}`;

const matchesOf = (text: string, value: string): readonly PiiMatch[] => {
  const found: PiiMatch[] = [];
  for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1))
    found.push({ start: at, end: at + value.length });
  return found;
};

@PiiPolicy({ name: "root-secret-pii-policy", action: PiiAction.mask() })
export class RootSecretPiiPolicy implements PiiPolicyHandler {
  findMatches(text: string): readonly PiiMatch[] {
    return matchesOf(text, ROOT_SECRET);
  }
}

@PiiPolicy({ name: "child-secret-pii-policy", action: PiiAction.mask() })
export class ChildSecretPiiPolicy implements PiiPolicyHandler {
  findMatches(text: string): readonly PiiMatch[] {
    return matchesOf(text, CHILD_SECRET);
  }
}

/** Every event an observer saw, as JSON, with the workflow it names. */
export const chainSeen: { hook: string; workflow: string; text: string }[] = [];

@Observer()
export class ChainObserver {
  private see(hook: string, event: { readonly workflow: { readonly name: string } }): void {
    chainSeen.push({ hook, workflow: event.workflow.name, text: JSON.stringify(event) });
  }
  onExecutionStart(event: ExecutionStartEvent): void {
    this.see("onExecutionStart", event);
  }
  onExecutionEnd(event: ExecutionEndEvent): void {
    this.see("onExecutionEnd", event);
  }
  onAgentStart(event: AgentStartEvent): void {
    this.see("onAgentStart", event);
  }
  onAgentEnd(event: AgentEndEvent): void {
    this.see("onAgentEnd", event);
  }
}

const price = { inputPerMTok: 1, outputPerMTok: 10 };

@Agent({
  name: "chain-child-agent",
  description: "Answers in the child",
  prompt: inline("Answer."),
  model: "test/chain-child",
  price,
})
export class ChainChildAgent {}

@Agent({
  name: "chain-peek-agent",
  description: "Sees the root's secret at its model",
  prompt: inline("Answer."),
  model: "test/chain-peek",
  price,
  excludePiiPolicies: [RootSecretPiiPolicy],
})
export class ChainPeekAgent {}

@Agent({
  name: "chain-open-agent",
  description: "Its workflow excludes the root's secret at its models",
  prompt: inline("Answer."),
  model: "test/chain-open",
  price,
})
export class ChainOpenAgent {}

@WorkflowFinish({
  name: "chain-child-workflow-finish",
  description: "The child's answer",
  output: WorkflowFinishTextDto,
})
export class ChainChildFinish {}

@WorkflowFinish({
  name: "chain-child-direct-workflow-finish",
  description: "Stop and hand the message back",
  output: WorkflowStartTextDto,
})
export class ChainChildDirectFinish {}

@Router({
  name: "chain-child-router",
  description: "Sends the message to the child's agent",
  decidedBy: DecidedBy.Model,
  prompt: inline("Pick who handles it."),
  model: "test/chain-router",
  input: { message: WorkflowStartTextDto },
  maxVisits: 1,
  routes: [
    { prompt: "Answer it", target: ChainChildAgent },
    { prompt: "Stop and hand it back", target: ChainChildDirectFinish },
  ],
})
export class ChainChildRouter {}

@WorkflowStart({
  name: "chain-child-workflow-start",
  description: "The child's message",
  input: WorkflowStartTextDto,
})
export class ChainChildStart {}

/** The child: a model router, then an agent; its own policy is the child's secret. */
@Workflow({
  name: "chain-child-workflow",
  version: "1.0.0",
  flow: [
    onStart(ChainChildStart)
      .toRouter(ChainChildRouter)
      .onRoute(toAgent(ChainChildAgent).toFinish(ChainChildFinish))
      .onRoute(toFinish(ChainChildDirectFinish)),
  ],
  piiPolicies: [ChildSecretPiiPolicy],
})
export class ChainChildWorkflow {}

@WorkflowStart({
  name: "chain-peek-workflow-start",
  description: "The child's message",
  input: WorkflowStartTextDto,
})
export class ChainPeekStart {}

@WorkflowFinish({
  name: "chain-peek-workflow-finish",
  description: "The child's answer",
  output: WorkflowFinishTextDto,
})
export class ChainPeekFinish {}

/** An agent that excludes the root's (inherited) policy. */
@Workflow({
  name: "chain-peek-workflow",
  version: "1.0.0",
  flow: [onStart(ChainPeekStart).toAgent(ChainPeekAgent).toFinish(ChainPeekFinish)],
  piiPolicies: [ChildSecretPiiPolicy],
})
export class ChainPeekWorkflow {}

@WorkflowStart({
  name: "chain-open-workflow-start",
  description: "The child's message",
  input: WorkflowStartTextDto,
})
export class ChainOpenStart {}

@WorkflowFinish({
  name: "chain-open-workflow-finish",
  description: "The child's answer",
  output: WorkflowFinishTextDto,
})
export class ChainOpenFinish {}

/** A workflow that excludes the root's (inherited) policy at all its models. */
@Workflow({
  name: "chain-open-workflow",
  version: "1.0.0",
  flow: [onStart(ChainOpenStart).toAgent(ChainOpenAgent).toFinish(ChainOpenFinish)],
  piiPolicies: [ChildSecretPiiPolicy],
  excludePiiPolicies: [RootSecretPiiPolicy],
})
export class ChainOpenWorkflow {}

@WorkflowStart({
  name: "chain-far-workflow-start",
  description: "The child's message",
  input: WorkflowStartTextDto,
})
export class ChainFarStart {}

@WorkflowFinish({
  name: "chain-far-workflow-finish",
  description: "The child's answer",
  output: WorkflowFinishTextDto,
})
export class ChainFarFinish {}

@Agent({
  name: "chain-far-agent",
  description: "Answers in a child on any instance",
  prompt: inline("Answer."),
  model: "test/chain-far",
  price,
})
export class ChainFarAgent {}

/** A child queued for any instance. */
@Workflow({
  placement: ChildPlacement.AnyWorker,
  name: "chain-far-workflow",
  version: "1.0.0",
  flow: [onStart(ChainFarStart).toAgent(ChainFarAgent).toFinish(ChainFarFinish)],
  piiPolicies: [ChildSecretPiiPolicy],
})
export class ChainFarWorkflow {}

const rootStart = (name: string) => {
  @WorkflowStart({ name, description: "A request", input: WorkflowStartTextDto })
  class RootStart {}
  return RootStart;
};

export const ChainRootStart = rootStart("chain-root-workflow-start");
export const ChainPeekRootStart = rootStart("chain-peek-root-workflow-start");
export const ChainOpenRootStart = rootStart("chain-open-root-workflow-start");
export const ChainFarRootStart = rootStart("chain-far-root-workflow-start");
export const ChainPlainRootStart = rootStart("chain-plain-root-workflow-start");

@WorkflowFinish({
  name: "chain-root-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
export class ChainRootFinish {}

@WorkflowFinish({
  name: "chain-root-direct-workflow-finish",
  description: "Handed back",
  output: WorkflowStartTextDto,
})
export class ChainRootDirectFinish {}

/** The root: its own policy is the root's secret; its child gets it too. */
@Workflow({
  name: "chain-root-workflow",
  version: "1.0.0",
  flow: [
    onStart(ChainRootStart)
      .toWorkflow(ChainChildWorkflow)
      .toOneOf([toFinish(ChainRootFinish), toFinish(ChainRootDirectFinish)]),
    onStart(ChainPeekRootStart).toWorkflow(ChainPeekWorkflow).toFinish(ChainRootFinish),
    onStart(ChainOpenRootStart).toWorkflow(ChainOpenWorkflow).toFinish(ChainRootFinish),
    onStart(ChainFarRootStart).toWorkflow(ChainFarWorkflow).toFinish(ChainRootFinish),
  ],
  piiPolicies: [RootSecretPiiPolicy],
})
export class ChainRootWorkflow {}

/** A root without the root's policy: the same child is masked by its own and the application's only. */
@Workflow({
  name: "chain-plain-root-workflow",
  version: "1.0.0",
  flow: [onStart(ChainPlainRootStart).toWorkflow(ChainPeekWorkflow).toFinish(ChainRootFinish)],
})
export class ChainPlainRootWorkflow {}

@Application({
  name: "chain-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChainRootWorkflow, ChainPlainRootWorkflow],
  piiPolicies: [ContactPiiPolicy],
  observers: [ChainObserver],
  retention: { executionRecords: hours(24) },
  budgets: TEST_BUDGETS,
})
export class ChainApplication {}
