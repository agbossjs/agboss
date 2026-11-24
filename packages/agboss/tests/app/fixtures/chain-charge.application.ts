/**
 * #1150 — a charge from inside a child whose root lists a PII policy the child does not: the
 * child's outbound call is stored masked by its chain (bug 4), wherever it runs.
 */
import { WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  ChildPlacement,
  PiiAction,
  PiiPolicy,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type PiiMatch,
  type PiiPolicyHandler,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart } from "../../helpers/flow.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";
import { EmailPiiPolicy } from "./outbound-call.workflow.js";
import {
  ChargedDto,
  ChildChargeAction,
  ChildChargeWorkflow,
  ChildChargedWorkflowFinish,
} from "./outbound-call-children.workflow.js";
import { PaymentGateway } from "./payment-gateway.js";

/** The order ids only the root workflows mask. */
@PiiPolicy({ name: "order-id-pii-policy", action: PiiAction.replaceWithKind() })
export class OrderIdPiiPolicy implements PiiPolicyHandler {
  findMatches(text: string): readonly PiiMatch[] {
    const at = text.indexOf("order-7");
    return at < 0 ? [] : [{ start: at, end: at + "order-7".length }];
  }
}

@WorkflowStart({
  name: "chain-far-charge-child-workflow-start",
  description: "An order",
  input: WorkflowStartTextDto,
})
export class ChainFarChargeChildStart {}

/** The same charge, as a child queued for any instance. */
@Workflow({
  name: "chain-far-charge-child-workflow",
  version: "1.0.0",
  flow: [
    onStart(ChainFarChargeChildStart)
      .returns(WorkflowStartTextDto)
      .toAction(ChildChargeAction)
      .returns(ChargedDto)
      .toFinish(ChildChargedWorkflowFinish),
  ],
  providers: [PaymentGateway],
})
export class ChainFarChargeChildWorkflow {}

@WorkflowStart({
  name: "chain-near-charge-workflow-start",
  description: "An order",
  input: WorkflowStartTextDto,
})
export class ChainNearChargeStart {}

@WorkflowStart({
  name: "chain-far-charge-workflow-start",
  description: "An order",
  input: WorkflowStartTextDto,
})
export class ChainFarChargeStart {}

@WorkflowFinish({
  name: "chain-charged-workflow-finish",
  description: "Charged",
  output: ChargedDto,
})
export class ChainChargedFinish {}

@Workflow({
  name: "chain-near-charge-workflow",
  version: "1.0.0",
  flow: [
    onStart(ChainNearChargeStart)
      .returns(WorkflowStartTextDto)
      .toWorkflow(ChildChargeWorkflow)
      .returns(ChargedDto)
      .toFinish(ChainChargedFinish),
  ],
  piiPolicies: [OrderIdPiiPolicy],
})
export class ChainNearChargeWorkflow {}

@Workflow({
  name: "chain-far-charge-workflow",
  version: "1.0.0",
  flow: [
    onStart(ChainFarChargeStart)
      .returns(WorkflowStartTextDto)
      .toWorkflow(ChainFarChargeChildWorkflow, { placement: ChildPlacement.AnyInstance })
      .returns(ChargedDto)
      .toFinish(ChainChargedFinish),
  ],
  piiPolicies: [OrderIdPiiPolicy],
})
export class ChainFarChargeWorkflow {}

@Application({
  name: "chain-charge-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [ChainNearChargeWorkflow, ChainFarChargeWorkflow],
  budgets: TEST_BUDGETS,
  piiPolicies: [EmailPiiPolicy],
})
export class ChainChargeApplication {}
