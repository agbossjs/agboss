import { AGBossError, type ErrorDetails } from "../core/errors.js";
import type { UsageRecord } from "../finops/usage.js";
import { currentFrame } from "../flow/context/frame.js";
import type { ComponentRecord } from "../flow/runtime/records.js";

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** A step of the run failed after spending money; carries that spend so the ledger still sees it. */
export class PaidStepError extends AGBossError {
  static override readonly code: string = "step";
  override name = "PaidStepError";
  readonly usage: readonly UsageRecord[];

  constructor(
    message: string,
    usage: readonly UsageRecord[],
    cause: unknown,
    details?: ErrorDetails,
  ) {
    super(message, { cause, ...(details === undefined ? {} : { details }) });
    this.usage = usage;
  }
}

/** Which step an error belongs to (#273 S22): its component, node id, visit and item. */
export interface StepCoordinates {
  readonly component: ComponentRecord;
  /** The node id in `result.path`: the component's `name` (`critic-agent#2` for a copy, #273). */
  readonly nodeId: string;
  /** The pass through the node in the execution, from 1; `0` for an error made outside any step. */
  readonly visitNumber: number;
  /** The item's index in a per-item launch (#273), from 0. */
  readonly itemIndex?: number;
}

/**
 * The coordinates of the step running now (its frame, #280); outside any step — a unit run on its
 * own — those of `name` at visit 0.
 */
export function stepCoordinatesOf(name: string): StepCoordinates {
  const frame = currentFrame();
  if (frame === undefined || frame.isClosed())
    return { component: { name }, nodeId: name, visitNumber: 0 };
  const { step } = frame;
  return {
    component: { name: step.component.name },
    nodeId: step.nodeId,
    visitNumber: step.visitNumber,
    ...(step.itemIndex === undefined ? {} : { itemIndex: step.itemIndex }),
  };
}

const detailsOfStep = (step: StepCoordinates): ErrorDetails => ({
  component: { name: step.component.name },
  nodeId: step.nodeId,
  visitNumber: step.visitNumber,
  ...(step.itemIndex === undefined ? {} : { itemIndex: step.itemIndex }),
});

/**
 * A step's own failure (#273 S22): an agent, a router, an action or a guard failed — never a limit,
 * a cancellation or a lost lease. It names the step (`component`, `nodeId`, `visitNumber`,
 * `itemIndex`), so `result`, the trace and the observers say which one failed; `FailurePolicy.Skip`
 * drops only these (S21). Subclasses by kind of node: `AgentFailedError`, `RouterFailedError`,
 * `ActionFailedError`, `GuardFailedError`.
 */
export class StepFailedError extends PaidStepError {
  static override readonly code: string = "step";
  override name = "StepFailedError";
  /** The component (no class: the error is kept on a plain record). */
  readonly component: ComponentRecord;
  readonly nodeId: string;
  readonly visitNumber: number;
  readonly itemIndex: number | undefined;

  constructor(
    message: string,
    usage: readonly UsageRecord[],
    cause: unknown,
    step: StepCoordinates,
    details: ErrorDetails = {},
  ) {
    super(message, usage, cause, { ...details, ...detailsOfStep(step) });
    this.component = { name: step.component.name };
    this.nodeId = step.nodeId;
    this.visitNumber = step.visitNumber;
    this.itemIndex = step.itemIndex;
  }
}

/** An agent's loop failed. */
export class AgentFailedError extends StepFailedError {
  static override readonly code: string = "step.agent";
  override name = "AgentFailedError";
  readonly agent: string;

  constructor(
    agent: string,
    usage: readonly UsageRecord[],
    cause: unknown,
    details: ErrorDetails = {},
  ) {
    const message = `Agent "${agent}" failed: ${describe(cause)}`;
    super(message, usage, cause, stepCoordinatesOf(agent), { agent, ...details });
    this.agent = agent;
  }
}

/** One judge's reason for rejecting an agent's reply. */
export interface JudgeFeedback {
  readonly judge: string;
  readonly feedback: string;
}

/** An agent's reply still failed its judges after `maxRetries` retries. */
export class QualityGateError extends AgentFailedError {
  static override readonly code: string = "step.agent.quality-gate";
  override name = "QualityGateError";
  /** What the judges said about the last reply. */
  readonly feedback: readonly JudgeFeedback[];
  readonly retries: number;

  constructor(
    agent: string,
    usage: readonly UsageRecord[],
    feedback: readonly JudgeFeedback[],
    retries: number,
  ) {
    const said = feedback.map((f) => `[${f.judge}] ${f.feedback}`).join("; ");
    const reason = `quality gate not passed after ${String(retries)} retries: ${said}`;
    super(agent, usage, reason, { feedback: feedback.map((f) => ({ ...f })), retries });
    this.feedback = feedback;
    this.retries = retries;
  }
}

/** A guard could not routeTo — the run fails closed instead of letting content through. */
export class GuardFailedError extends StepFailedError {
  static override readonly code: string = "step.guard";
  override name = "GuardFailedError";
  readonly guard: string;

  constructor(guard: string, usage: readonly UsageRecord[], reason: string) {
    super(`Guard "${guard}" failed: ${reason}`, usage, reason, stepCoordinatesOf(guard), { guard });
    this.guard = guard;
  }
}
