import {
  Action,
  EmptyEnvironment,
  ExecutionContext,
  SpendRecorder,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  listOf,
  type Produced,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { Injectable } from "../../../src/components/decorators.js";
import { Clock } from "../../../src/infrastructure/clock.js";
import {
  InMemoryCostLedgerRepository,
  type CostCounter,
} from "../../../src/infrastructure/cost-ledger.repository.js";
import type { UsageRecord } from "../../../src/finops/usage.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { seconds, usd } from "../../../src/units/index.js";
import { OrderDto } from "./paid-steps.dto.js";

/**
 * #770 — a ledger write whose answer was lost, beside a sibling that works on. Under
 * `TEST_BUDGETS` (an execution may spend $100) a launch runs `pay-thrice-action` — $60, $25 and
 * $1, a second apart on the clock, so each write before it and its read are done — beside `work-action`, which works
 * until the test lets it go. The ledger keeps the $60 write and loses its answer when
 * `lostAnswer.isLosing` is set. $86 is spent in all: the execution finishes either way.
 */

export const lostAnswer = {
  isLosing: false,
  /** How many answers the ledger lost. */
  lost: 0,
  /** What the actions did, in order. */
  log: [] as string[],
  /** Lets `work-action` finish. */
  release: (): void => undefined,
};

export function resetLostAnswer(isLosing: boolean): void {
  Object.assign(lostAnswer, { isLosing, lost: 0, log: [] });
}

/** A ledger that keeps the $60 write and, when told, answers it with an error: the answer lost. */
@Injectable()
export class LostAnswerLedger extends InMemoryCostLedgerRepository {
  override async saveAll(
    counters: readonly CostCounter[],
    records: readonly UsageRecord[],
  ): Promise<void> {
    await super.saveAll(counters, records);
    const isLost =
      lostAnswer.isLosing &&
      lostAnswer.lost === 0 &&
      records.some((record) => record.costUsd === 60);
    if (!isLost) return;
    lostAnswer.lost += 1;
    throw new Error("the connection reset after the commit");
  }
}

@Action({
  name: "pay-thrice-action",
  description: "Pays a service $60, $25 and $1",
  input: { order: OrderDto },
  output: OrderDto,
  deps: [SpendRecorder, Clock],
})
export class PayThriceAction {
  constructor(
    private readonly spendRecorder: SpendRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(input: { readonly order: Produced<OrderDto, unknown> }): Promise<OrderDto> {
    for (const cost of [60, 25, 1]) {
      this.spendRecorder.record({ service: "order-api", cost: usd(cost) });
      await this.clock.sleep(seconds(1));
    }
    lostAnswer.log.push("paid");
    return input.order.value;
  }
}

@Action({
  name: "work-action",
  description: "Works on until the test lets it go",
  input: { order: OrderDto },
  output: OrderDto,
  deps: [ExecutionContext],
})
export class WorkAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  async execute(input: { readonly order: Produced<OrderDto, unknown> }): Promise<OrderDto> {
    const { signal } = this.executionContext;
    await new Promise<void>((resolve, reject) => {
      lostAnswer.release = resolve;
      signal.addEventListener(
        "abort",
        () => {
          lostAnswer.log.push("stopped");
          reject(signal.reason instanceof Error ? signal.reason : new Error("the step was stopped"));
        },
        { once: true },
      );
    });
    lostAnswer.log.push("worked");
    return input.order.value;
  }
}

@WorkflowStart({ name: "lost-answer-workflow-start", description: "An order", input: OrderDto })
export class LostAnswerWorkflowStart {}

@WorkflowFinish({
  name: "lost-answer-workflow-finish",
  description: "Paid and worked",
  input: { results: listOf(OrderDto) },
  output: OrderDto,
})
export class LostAnswerWorkflowFinish {
  finish(input: { readonly results: readonly Produced<OrderDto, unknown>[] }): OrderDto {
    const ids = input.results.map((result) => result.value.orderId);
    return { orderId: ids.join(",") };
  }
}

@Workflow({
  name: "lost-answer-workflow",
  version: "1.0.0",
  flow: [
    start(LostAnswerWorkflowStart)
      .returns(OrderDto)
      .toParallelActions(PayThriceAction, WorkAction)
      .join()
      .returns(listOf(OrderDto))
      .toFinish(LostAnswerWorkflowFinish),
  ],
})
export class LostAnswerWorkflow {}

@Application({
  name: "lost-answer-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LostAnswerWorkflow],
  budgets: TEST_BUDGETS,
  providers: [LostAnswerLedger],
})
export class LostAnswerApplication {}
