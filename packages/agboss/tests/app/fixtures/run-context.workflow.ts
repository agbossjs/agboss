import { TerminalUserChannel } from "../../../src/channels/terminal-channel.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  Agent,
  ExecutionContext,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import type { StepDescriptor, ToolHandler } from "../../../src/index.js";
import { start } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";

/** What a component read of its execution (`deps: [ExecutionContext]`, #280). */
export interface ExecutionSnapshot {
  readonly executionId: string;
  readonly threadId: string;
  readonly ownerId: string | undefined;
  readonly signal: AbortSignal;
  readonly step: StepDescriptor;
}

const snapshotOf = (executionContext: ExecutionContext): ExecutionSnapshot => ({
  executionId: executionContext.executionId,
  threadId: executionContext.threadId,
  ownerId: executionContext.ownerId,
  signal: executionContext.signal,
  step: executionContext.step,
});

/** What the components saw of their execution, in order (the tests reset it with `resetSeen`). */
export const seen = {
  probes: [] as ExecutionSnapshot[],
  charges: [] as ExecutionSnapshot[],
  /** One entry per execution of the payment action. */
  payments: [] as ExecutionSnapshot[],
  /** The execution signals a blocking call got. */
  blocked: [] as AbortSignal[],
};

export function resetSeen(): void {
  for (const list of Object.values(seen)) list.length = 0;
}

/** Resolves when a blocking call started, with its thread (set by the test before the run). */
export const blocking: { started?: (thread: string) => void } = {};

/** The clerk's answer, kept by the finish. */
export class ReceiptDto {
  @Text({ prompt: "what was done" })
  text!: string;
}

export class Query {
  @Text({ prompt: "what to look up" })
  text!: string;
}

/** A read tool: records the execution it was called in. */
@Tool({
  name: "probe-tool",
  description: "Looks something up",
  input: Query,
  output: Query,
  deps: [ExecutionContext],
})
export class Probe implements ToolHandler<Query, Query> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run(input: Query): Promise<Query> {
    seen.probes.push(snapshotOf(this.executionContext));
    return Promise.resolve(input);
  }
}

/** A write tool: it waits for an approval, so a run pauses before it. */
@Tool({
  name: "charge-tool",
  description: "Charges the card",
  channel: TerminalUserChannel,
  input: Query,
  output: Query,
  deps: [ExecutionContext],
})
export class Charge implements ToolHandler<Query, Query> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run(input: Query): Promise<Query> {
    seen.charges.push(snapshotOf(this.executionContext));
    return Promise.resolve(input);
  }
}

/** A long call: it waits until its execution is cancelled. */
@Tool({
  name: "wait-tool",
  description: "Waits for a long time",
  input: Query,
  output: Query,
  deps: [ExecutionContext],
})
export class Wait implements ToolHandler<Query, Query> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run(input: Query): Promise<Query> {
    const { signal, threadId } = this.executionContext;
    seen.blocked.push(signal);
    blocking.started?.(threadId);
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        resolve(input);
      });
    });
  }
}

/** A slow read: the other branch answers meanwhile. */
@Tool({ name: "slow-tool", description: "Looks something up slowly", input: Query, output: Query })
export class Slow implements ToolHandler<Query, Query> {
  run(input: Query): Promise<Query> {
    return new Promise((resolve) =>
      setTimeout(() => {
        resolve(input);
      }, 100),
    );
  }
}

@Agent({
  name: "clerk-agent",
  description: "Looks things up, charges cards and waits",
  prompt: "Do what you are asked.",
  tools: [Probe, Charge, Wait, Slow],
  model: "test/clerk",
  input: { message: WorkflowStartTextDto },
  output: ReceiptDto,
})
export class Clerk {}

/** Records that it ran (a payment) and the step it ran in. */
@Action({ name: "pay-action", description: "Pays", deps: [ExecutionContext] })
export class Pay {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(): Promise<void> {
    seen.payments.push(snapshotOf(this.executionContext));
    return Promise.resolve();
  }
}

@WorkflowStart({
  name: "start-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class Start {}

@WorkflowFinish({ name: "finish-workflow-finish", description: "The reply", output: ReceiptDto })
export class Finish {}

const defaults = {
  models: { maxTokens: 100, temperature: 0 },
  tools: { maxToolCalls: 3 },
};

/** The clerk, then the payment. */
@Workflow({
  name: "checkout-workflow",
  version: "1.0.0",
  defaults,
  uncompactedTurns: 1,
  providers: [Pay],
  flow: [
    start(Start)
      .returns(WorkflowStartTextDto)
      .toAgent(Clerk)
      .returns(ReceiptDto)
      .toAction(Pay)
      .toFinish(Finish),
  ],
})
export class Checkout {}

@Application({
  name: "checkout-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [Checkout],
  budgets: TEST_BUDGETS,
})
export class CheckoutApplication {}
