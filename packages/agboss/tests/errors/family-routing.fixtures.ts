import {
  Action,
  AGBossError,
  EmptyEnvironment,
  ExecutionError,
  LimitError,
  StepError,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../src/index.js";
import { A2AExpose } from "../../src/a2a/index.js";
import { errorRecordOf, RecordedError } from "../../src/core/error-record.js";
import { Application } from "../../src/application/application.js";
import { BearerCallerResolver } from "../a2a/fixtures/bearer-caller-resolver.js";
import { Text } from "../../src/dto/index.js";
import { ComponentKind, bareRecordOf } from "../../src/flow/runtime/records.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart, toFinish } from "../helpers/flow.js";

/** Which error the action throws. */
export class AskDto {
  @Text() fail!: string;
}

export class OutDto {
  @Text() fail!: string;
}

/** A project's own errors: no `static code`, so each is caught by its class name (#1325a). */
export class OnePaymentError extends AGBossError {}
export class OtherPaymentError extends AGBossError {}

/** A third-party SDK's error: its own code, name and a message that carries what must never leave. */
export class StripeCardError extends Error {
  static readonly code = "card_declined_4242";
  override name = "StripeCardError";
}
export const CARD_SECRET = "alice@example.com card 4242 4242 4242 4242 sk_live_abc123";

const where = { nodeId: "throwing-action", visitNumber: 1, itemIndex: undefined };

const component = bareRecordOf("throwing-action", ComponentKind.Action);
const agentError = (): StepError.Agent => new StepError.Agent({ agent: "x", component, ...where });
const fenced = (): ExecutionError.Fenced =>
  new ExecutionError.Fenced({
    scopeKey: "t:run-1",
    token: 1,
    tenantId: "t",
    leaseExecutionId: "run-1",
  });

/** What each `fail` throws: a family's error, a hand-over, a project's own, a recorded one. */
const THROWN: Readonly<Record<string, (() => Error) | undefined>> = {
  "step-action": () => new StepError.Action({ action: "throwing-action", component, ...where }),
  "step-agent": agentError,
  "limit-items": () =>
    new LimitError.Items({ node: "n", limit: 1, actual: 2, path: [], spentUsd: 0 }),
  "unknown-thread": () => new ExecutionError.UnknownThread(),
  "lease-lost": () => new ExecutionError.LeaseLost({ rootExecutionId: "run-1" }),
  fenced,
  "one-payment": () => new OnePaymentError("declined"),
  "other-payment": () => new OtherPaymentError("declined"),
  "recorded-third-party": () => new RecordedError(errorRecordOf(new StripeCardError(CARD_SECRET))),
  "recorded-framework": () => new RecordedError(errorRecordOf(agentError())),
};

/** Throws, by `fail`, an error of a family, a hand-over, or a project's own. */
@Action({
  name: "throwing-action",
  description: "Throws the error its input names",
  input: { ask: AskDto },
  output: OutDto,
})
export class ThrowingAction {
  execute({ ask }: { readonly ask: { readonly value: AskDto } }): Promise<OutDto> {
    const { fail } = ask.value;
    const make = THROWN[fail];
    if (make !== undefined) throw make();
    return Promise.resolve({ fail });
  }
}

@WorkflowStart({ name: "family-route-workflow-start", description: "What to throw", input: AskDto })
export class FamilyRouteStart {}

@WorkflowFinish({
  name: "family-route-ok-workflow-finish",
  description: "Nothing thrown",
  output: OutDto,
})
export class FamilyOkFinish {}

@WorkflowFinish({
  name: "family-route-variant-workflow-finish",
  description: "A variant caught",
  output: AskDto,
})
export class VariantCaughtFinish {}

@WorkflowFinish({
  name: "family-route-limit-workflow-finish",
  description: "The limit family caught",
  output: AskDto,
})
export class LimitCaughtFinish {}

@WorkflowFinish({
  name: "family-route-execution-workflow-finish",
  description: "The execution family caught",
  output: AskDto,
})
export class ExecutionCaughtFinish {}

@WorkflowFinish({
  name: "family-route-own-workflow-finish",
  description: "A project's error caught",
  output: AskDto,
})
export class OwnCaughtFinish {}

@Workflow({
  name: "family-route-workflow",
  version: "1.0.0",
  flow: [
    onStart(FamilyRouteStart)
      .toAction(ThrowingAction)
      .onError(StepError.Action, toFinish(VariantCaughtFinish))
      .onError(LimitError, toFinish(LimitCaughtFinish))
      .onError(ExecutionError, toFinish(ExecutionCaughtFinish))
      .onError(OnePaymentError, toFinish(OwnCaughtFinish))
      .toFinish(FamilyOkFinish),
  ],
})
export class FamilyRouteWorkflow {}

@Application({
  name: "family-route-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FamilyRouteWorkflow],
  budgets: TEST_BUDGETS,
})
export class FamilyRouteApplication {}

/** The family-routing workflow served over A2A, for the failures that reach the wire. */
@A2AExpose({
  name: "family-route-a2a-expose",
  version: "1.0.0",
  description: "Throws what it is asked to",
  exports: [FamilyRouteStart],
})
export class FamilyRouteA2AExpose {}

@Application({
  name: "family-route-served-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FamilyRouteWorkflow],
  providers: [BearerCallerResolver],
  exposes: [FamilyRouteA2AExpose],
  budgets: TEST_BUDGETS,
})
export class FamilyRouteServedApplication {}
