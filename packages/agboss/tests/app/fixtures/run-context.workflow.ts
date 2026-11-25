import { hours, Ttl } from "../../../src/units/index.js";
import { Window1Memory } from "../../helpers/window-memory.js";
import { OwnerToolApproval } from "../../flow/fixtures/owner-approval.fixture.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  Agent,
  ExecutionContext,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
  PiiKind,
  PiiPolicy,
} from "../../../src/index.js";
import type { StepDescriptor } from "../../../src/index.js";
import { onStart } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

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
export class Probe {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: Query): Promise<Query> {
    seen.probes.push(snapshotOf(this.executionContext));
    return Promise.resolve(input);
  }
}

/** A write tool: it waits for an approval, so a run pauses before it. */
@Tool({
  name: "charge-tool",
  description: "Charges the card",
  approval: OwnerToolApproval,
  input: Query,
  output: Query,
  deps: [ExecutionContext],
})
export class Charge {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: Query): Promise<Query> {
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
export class Wait {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: Query): Promise<Query> {
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
export class Slow {
  execute(input: Query): Promise<Query> {
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
  prompt: inline("Do what you are asked."),
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
  historyTtl: Ttl.Forever,
  defaults,
  memory: Window1Memory,
  providers: [Pay],
  flow: [
    onStart(Start)
      .toAgent(Clerk)
      .toAction(Pay)
      .toFinish(Finish),
  ],
})
export class Checkout {}

@Application({
  name: "checkout-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [Checkout],
  budgets: TEST_BUDGETS,
})
export class CheckoutApplication {}

/** The same application keeping its execution history (`retention.executionRecords`, #1341d). */
@Application({
  name: "kept-checkout-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [Checkout],
  budgets: TEST_BUDGETS,
  retention: { executionRecords: hours(24) },
})
export class KeptCheckoutApplication {}

/** Hides e-mail addresses in what is observed and kept (an operator's reasons too). */
@PiiPolicy({
  name: "checkout-email-pii-policy",
  description: "Hides e-mail addresses",
  rules: [PiiKind.Email.mask()],
})
export class CheckoutEmailPiiPolicy {}

/** The checkout under a PII policy. */
@Workflow({
  name: "masked-checkout-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  defaults,
  memory: Window1Memory,
  providers: [Pay],
  piiPolicies: [CheckoutEmailPiiPolicy],
  flow: [
    onStart(Start)
      .toAgent(Clerk)
      .toAction(Pay)
      .toFinish(Finish),
  ],
})
export class MaskedCheckout {}

/** The masked checkout, keeping its execution history. */
@Application({
  name: "masked-checkout-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [MaskedCheckout],
  budgets: TEST_BUDGETS,
  retention: { executionRecords: hours(24) },
})
export class MaskedCheckoutApplication {}
