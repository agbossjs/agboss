import { Enum, Text } from "../../../../src/dto/index.js";
import {
  Action,
  oneOf,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  Ttl,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { onStart, toAction, toFinish } from "../../../helpers/flow.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";

/**
 * #1275b: a child workflow with three finishes, two of them (`kyc-fraud`, `kyc-expired`) giving
 * one DTO — `.toOneOf([…])` cannot tell them apart, `.onFinish(ChildFinish, …)` names the finish.
 */

export class KycRequestDto {
  @Text({ prompt: "the customer" })
  customer!: string;

  @Enum(["ok", "fraud", "expired"], { prompt: "what the check found" })
  found!: "ok" | "fraud" | "expired";
}

export class KycOkDto {
  @Text({ prompt: "the verified customer" })
  customer!: string;
}

export class KycFraudDto {
  @Text({ prompt: "what looked like fraud" })
  why!: string;
}

export class KycLapsedDto {
  @Text({ prompt: "what lapsed" })
  what!: string;
}

export class RejectionDto {
  @Text({ prompt: "why the customer is turned away" })
  reason!: string;
}

export class OnboardedDto {
  @Text({ prompt: "the account" })
  account!: string;
}

export class TurnedAwayDto {
  @Text({ prompt: "what the customer is told" })
  told!: string;
}

/** What ran in the parent, in order. */
export const onboarding: string[] = [];

@WorkflowStart({ name: "kyc-workflow-start", description: "A customer", input: KycRequestDto })
export class KycStart {}

@Action({
  name: "kyc-check-action",
  description: "Checks the customer",
  input: { request: KycRequestDto },
  output: oneOf(KycOkDto, KycFraudDto, KycLapsedDto),
})
export class KycCheckAction {
  execute(input: { readonly request: KycRequestDto }): Promise<unknown> {
    const { customer, found } = input.request;
    if (found === "ok") return Promise.resolve({ customer });
    if (found === "fraud") return Promise.resolve({ why: customer });
    return Promise.resolve({ what: customer });
  }
}

@Action({
  name: "reject-fraud-action",
  description: "Turns a fraud away",
  input: { fraud: KycFraudDto },
  output: RejectionDto,
})
export class RejectFraudAction {
  async execute(): Promise<RejectionDto> {
    return Promise.resolve({ reason: "fraud" });
  }
}

@Action({
  name: "reject-lapsed-action",
  description: "Turns a lapsed check away",
  input: { lapsed: KycLapsedDto },
  output: RejectionDto,
})
export class RejectLapsedAction {
  async execute(): Promise<RejectionDto> {
    return Promise.resolve({ reason: "lapsed" });
  }
}

@WorkflowFinish({ name: "kyc-verified-workflow-finish", description: "Verified", output: KycOkDto })
export class KycVerifiedFinish {}

@WorkflowFinish({ name: "kyc-fraud-workflow-finish", description: "Fraud", output: RejectionDto })
export class KycFraudFinish {}

@WorkflowFinish({
  name: "kyc-expired-workflow-finish",
  description: "Lapsed",
  output: RejectionDto,
})
export class KycExpiredFinish {}

@Workflow({
  name: "kyc-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(KycStart)
      .toAction(KycCheckAction)
      .toOneOf([
        toFinish(KycVerifiedFinish),
        toAction(RejectFraudAction)
          .toFinish(KycFraudFinish),
        toAction(RejectLapsedAction)
          .toFinish(KycExpiredFinish),
      ]),
  ],
})
export class KycWorkflow {}

@WorkflowStart({ name: "onboard-workflow-start", description: "A customer", input: KycRequestDto })
export class OnboardStart {}

@Action({
  name: "open-account-action",
  description: "Opens the account",
  input: { ok: KycOkDto },
  output: OnboardedDto,
})
export class OpenAccountAction {
  async execute(): Promise<OnboardedDto> {
    onboarding.push("open");
    return Promise.resolve({ account: "opened" });
  }
}

@Action({
  name: "block-user-action",
  description: "Blocks the customer",
  input: { rejection: RejectionDto },
  output: TurnedAwayDto,
})
export class BlockUserAction {
  async execute(): Promise<TurnedAwayDto> {
    onboarding.push("block");
    return Promise.resolve({ told: "blocked" });
  }
}

@Action({
  name: "retry-later-action",
  description: "Asks the customer to come back",
  input: { rejection: RejectionDto },
  output: TurnedAwayDto,
})
export class RetryLaterAction {
  async execute(): Promise<TurnedAwayDto> {
    onboarding.push("retry");
    return Promise.resolve({ told: "come back" });
  }
}

@WorkflowFinish({
  name: "onboarded-workflow-finish",
  description: "Onboarded",
  output: OnboardedDto,
})
export class OnboardedFinish {}

@WorkflowFinish({
  name: "turned-away-workflow-finish",
  description: "Turned away",
  output: TurnedAwayDto,
})
export class TurnedAwayFinish {}

@Workflow({
  name: "onboard-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(OnboardStart)
      .toWorkflow(KycWorkflow)
      .onFinish(KycVerifiedFinish, toAction(OpenAccountAction)
        .toFinish(OnboardedFinish))
      .onFinish(KycFraudFinish, toAction(BlockUserAction)
        .toFinish(TurnedAwayFinish))
      .onFinish(KycExpiredFinish, toAction(RetryLaterAction)
        .toFinish(TurnedAwayFinish)),
  ],
})
export class OnboardWorkflow {}

@Application({
  name: "onboard-application",
  version: "1.0.0",
  workflows: [OnboardWorkflow, KycWorkflow],
  budgets: TEST_BUDGETS,
})
export class OnboardApplication {}
