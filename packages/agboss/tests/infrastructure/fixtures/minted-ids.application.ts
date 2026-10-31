import { EmptyEnvironment, IdGenerator, Injectable } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { SingleChildWorkflow } from "../../channels/fixtures/child-pauses.workflow.js";
import {
  CustomerOrderConfirmationChannel,
  FinanceDeskRefundApprovalChannel,
  PauseLog,
  SeenPausedExecutionRepository,
} from "../../channels/fixtures/pauses.workflow.js";

/**
 * #578 — a project's own `IdGenerator` whose next ids each test sets: what it mints is held to the
 * key-text rules (#538, #547, #556) at the mint, like every id that comes in.
 */

/** The ids the generator mints next, in order (a test's own); when empty, `thread-N` / `execution-N`. */
export const minting: { threads: unknown[]; executions: unknown[]; count: number } = {
  threads: [],
  executions: [],
  count: 0,
};

/** Before each test: nothing planned, the count from 1. */
export function resetMinting(): void {
  minting.threads = [];
  minting.executions = [];
  minting.count = 0;
}

const nextOf = (planned: unknown[], kind: string): string => {
  minting.count += 1;
  // a JavaScript project's generator may return anything: the test plans non-strings too
  return (planned.length > 0 ? planned.shift() : `${kind}-${String(minting.count)}`) as string;
};

/** Mints what the test planned, else a sequential id. */
@Injectable()
export class PlannedIdGenerator extends IdGenerator {
  override newThreadId(): string {
    return nextOf(minting.threads, "thread");
  }

  override newExecutionId(): string {
    return nextOf(minting.executions, "execution");
  }
}

/** A root and its child (a pause), in memory, on the planned ids. */
@Application({
  name: "planned-ids-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SingleChildWorkflow],
  providers: [
    PlannedIdGenerator,
    FinanceDeskRefundApprovalChannel,
    CustomerOrderConfirmationChannel,
    SeenPausedExecutionRepository,
  ],
  observers: [PauseLog],
  budgets: TEST_BUDGETS,
})
export class PlannedIdsApplication {}
