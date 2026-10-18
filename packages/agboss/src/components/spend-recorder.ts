import { AGBossError } from "../core/errors.js";
import { currentFrame } from "../flow/context/frame.js";
import { ZERO_USAGE, type UsageRecord } from "../finops/usage.js";
import type { Usd } from "../units/index.js";

/** What a paid service that is not a model cost one call: `{ service: "serp-api", cost: usd(0.002) }`. */
export interface ServiceSpend {
  /** The service paid for — the record's `model` in the cost report. */
  readonly service: string;
  readonly cost: Usd;
}

/**
 * Where a tool or an action records what it paid a service that is not a model (#280 S43):
 * `deps: [SpendRecorder]`, `this.spendRecorder.record({ service, cost })`. The record joins the
 * spend of the current tool call or step — the execution's cost report and every one of its budgets
 * (`BudgetExceededError` on the next check, like model spend).
 */
export abstract class SpendRecorder {
  abstract record(spend: ServiceSpend): void;
}

/** `spendRecorder.record(…)` outside a step or a tool call: nothing to bill it to. */
export class SpendOutsideStepError extends AGBossError {
  static override readonly code: string = "spend.outside-step";
  override name = "SpendOutsideStepError";
}

/** The caller of a service's spend until its frame names it (`tool:<name>`, `action:<name>`). */
const serviceCaller = (service: string): string => `service:${service}`;

/** The record of one service call (a cost the service charged, no tokens). */
export const serviceUsageOf = ({ service, cost }: ServiceSpend): UsageRecord => ({
  caller: serviceCaller(service),
  model: service,
  ...ZERO_USAGE,
  costUsd: cost,
  costSource: "tool",
});

/** The injected `SpendRecorder`: one per consumer, recording into the frame of the current step. */
export class LiveSpendRecorder extends SpendRecorder {
  constructor(private readonly consumer: string) {
    super();
    Object.freeze(this);
  }

  record(spend: ServiceSpend): void {
    const frame = currentFrame();
    const report = frame?.isClosed() === false ? frame.services.reportUsage : undefined;
    if (report === undefined) {
      throw new SpendOutsideStepError(
        `[spend.outside-step] ${this.consumer} recorded ${spend.service} spend outside a step or a tool call — record it while the step (or the tool call) runs`,
      );
    }
    report(serviceUsageOf(spend));
  }
}
