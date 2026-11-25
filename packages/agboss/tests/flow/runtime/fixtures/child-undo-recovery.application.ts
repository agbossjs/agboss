import {
  EmptyEnvironment,
  Observer,
  type CompensationStartEvent,
  type ExecutionEndEvent,
  type ExecutionErrorEvent,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { seconds } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { MortalExecutionLeaseRepository } from "../../../infrastructure/fixtures/recovery.workflow.js";
import {
  ChargedTripWorkflow,
  CommitTripWorkflow,
  DeclinedTripWorkflow,
} from "../../fixtures/child-undo.fixture.js";
import { JoinDeclinedTripWorkflow } from "./held-undo.workflow.js";

/**
 * The crash between a child's finish and its parent taking what it moved up: the child's end
 * event is held (it is awaited in the parent's step, after the child's finish became durable and
 * before the parent's step writes), so the test can kill the instance right there.
 */
export const childEndGate: {
  isArmed: boolean;
  reached: boolean;
  release: () => void;
  rootEnds: string[];
} = { isArmed: false, reached: false, release: () => undefined, rootEnds: [] };

export function resetChildEndGate(): void {
  childEndGate.isArmed = false;
  childEndGate.reached = false;
  childEndGate.release = () => undefined;
  childEndGate.rootEnds.length = 0;
}

/**
 * A crash in the middle of an automatic undo (#1281 (10)): the `at`-th `onCompensationStart` (from 1)
 * is held — the undos before it ran and were marked done —, so the test can kill the instance there.
 */
export const undoStartGate: {
  at: number | undefined;
  started: number;
  reached: boolean;
  release: () => void;
} = { at: undefined, started: 0, reached: false, release: () => undefined };

export function resetUndoStartGate(): void {
  undoStartGate.at = undefined;
  undoStartGate.started = 0;
  undoStartGate.reached = false;
  undoStartGate.release = () => undefined;
}

@Observer({ name: "child-end-gate" })
export class ChildEndGate {
  async onCompensationStart(_event: CompensationStartEvent): Promise<void> {
    undoStartGate.started += 1;
    if (undoStartGate.started !== undoStartGate.at) return;
    undoStartGate.reached = true;
    await new Promise<void>((resolve) => {
      undoStartGate.release = resolve;
    });
  }

  async onExecutionEnd(event: ExecutionEndEvent): Promise<void> {
    if (event.parentExecutionId === undefined) {
      childEndGate.rootEnds.push(`finished ${event.finish.name}`);
      return;
    }
    if (!childEndGate.isArmed) return;
    childEndGate.isArmed = false;
    childEndGate.reached = true;
    await new Promise<void>((resolve) => {
      childEndGate.release = resolve;
    });
  }

  onExecutionError(event: ExecutionErrorEvent): void {
    if (event.parentExecutionId === undefined) childEndGate.rootEnds.push("failed");
  }
}

/** The one-level parents on two instances whose lease store the test can kill. */
@Application({
  name: "child-undo-recovery-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [
    ChargedTripWorkflow,
    CommitTripWorkflow,
    DeclinedTripWorkflow,
    JoinDeclinedTripWorkflow,
  ],
  observers: [ChildEndGate],
  providers: [MortalExecutionLeaseRepository],
  budgets: TEST_BUDGETS,
  executionLimits: { compensationTimeout: seconds(60) },
})
export class ChildUndoRecoveryApplication {}
