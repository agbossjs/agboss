import { AGBossError, type ErrorDetails } from "../core/errors.js";
import type { UsageRecord } from "../finops/usage.js";
import { currentFrame } from "../flow/context/frame.js";
import { ComponentKind, type ComponentRecord } from "../flow/runtime/records.js";
import { bareRecordOf, plainRecordOf } from "../flow/runtime/records.js";

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** What a step's error that spent money takes: its facts, the spend, the cause (#906). */
export interface PaidStepErrorOptions {
  readonly message: string;
  /** The spend the failed step made, so the ledger still sees it. */
  readonly usage: readonly UsageRecord[];
  readonly cause?: unknown;
  readonly details?: ErrorDetails;
}

/**
 * A step of the run failed after spending money; carries that spend so the ledger still sees it.
 * Its instance `code` is the union of the codes of its family — this class's `step` and every
 * class below it — so `switch (error.code)` narrows (#906); a class of yours extending it keeps
 * its own `static code`, and declares its instance `code` as `string`-compatible only through that union.
 */
export class PaidStepError extends AGBossError {
  static override readonly code: string = "step";
  declare readonly code:
    | "step"
    | "step.failed"
    | "step.agent"
    | "step.agent.quality-gate"
    | "step.agent.invalid-answer"
    | "step.guard"
    | "step.router"
    | "step.router.invalid-decision"
    | "step.action"
    | "step.question"
    | "step.child"
    | "step.arbiter"
    | "step.quorum"
    | "step.tool-blocked"
    | "step.rerank-failed"
    | "outbound-call.in-flight"
    | "outbound-call.superseded"
    | "outbound-call.unreconciled"
    | "outbound-call.result-not-stored"
    | "guardrail.blocked"
    | "pii.refused"
    | "pii.detection-failed";
  override name = "PaidStepError";
  readonly usage: readonly UsageRecord[];

  constructor(options: PaidStepErrorOptions) {
    const { message, usage, cause, details } = options;
    super(message, { cause, ...(details === undefined ? {} : { details }) });
    this.usage = usage;
  }
}

/** Which step an error belongs to (#273 S22): its component, node id, visit and item. */
export interface StepCoordinates {
  /** The step's component, by `name`. */
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
 * own — those of `name` (a `kind`) at visit 0.
 */
export function stepCoordinatesOf(name: string, kind: ComponentKind): StepCoordinates {
  const frame = currentFrame();
  if (frame === undefined || frame.isClosed())
    return { component: bareRecordOf(name, kind), nodeId: name, visitNumber: 0 };
  const { step } = frame;
  return {
    component: plainRecordOf(step.component),
    nodeId: step.nodeId,
    visitNumber: step.visitNumber,
    ...(step.itemIndex === undefined ? {} : { itemIndex: step.itemIndex }),
  };
}

const detailsOfStep = (step: StepCoordinates): ErrorDetails => ({
  component: plainRecordOf(step.component),
  nodeId: step.nodeId,
  visitNumber: step.visitNumber,
  ...(step.itemIndex === undefined ? {} : { itemIndex: step.itemIndex }),
});

/** What a step's own failure takes: the step's coordinates, the spend and the cause (#906). */
export interface StepFailedErrorOptions extends PaidStepErrorOptions, StepCoordinates {}

/**
 * A step's own failure (#273 S22): an agent, a router, an action or a guard failed — never a limit,
 * a cancellation or a lost lease. It names the step (`component`, `nodeId`, `visitNumber`,
 * `itemIndex`), so `result`, the trace and the observers say which one failed; `FailurePolicy.Skip`
 * drops only these (S21). Its own code `step.failed` (lineage `[step.agent, step.failed, step]`)
 * makes `.onError(StepFailedError)` / `.onJoinError(StepFailedError)` take exactly these. Subclasses by kind of node: `AgentFailedError`, `RouterFailedError`,
 * `ActionFailedError`, `GuardFailedError`.
 */
export class StepFailedError extends PaidStepError {
  static override readonly code: string = "step.failed";
  /** The codes of this class and every class below it (#906): `switch (error.code)` narrows. */
  declare readonly code: Exclude<
    PaidStepError["code"],
    "step" | "guardrail.blocked" | "pii.refused" | "pii.detection-failed"
  >;
  override name = "StepFailedError";
  /** The component (no class: the error is kept on a plain record). */
  readonly component: ComponentRecord;
  /** The step's node id: `critic-agent#2` for a copy of a launch. */
  readonly nodeId: string;
  /** The pass through the node, from 1 (`0` outside any step). */
  readonly visitNumber: number;
  /** The item's index of a per-item launch; `undefined` otherwise. */
  readonly itemIndex: number | undefined;

  constructor(options: StepFailedErrorOptions) {
    const { message, usage, cause, details = {}, ...step } = options;
    super({ message, usage, cause, details: { ...details, ...detailsOfStep(step) } });
    this.component = plainRecordOf(step.component);
    this.nodeId = step.nodeId;
    this.visitNumber = step.visitNumber;
    this.itemIndex = step.itemIndex;
  }
}

/** What an agent's failure takes: the agent, the spend and what failed (#906). */
export interface AgentFailedErrorOptions {
  /** The agent's `name`. */
  readonly agent: string;
  readonly usage: readonly UsageRecord[];
  /** What failed: the loop's error, or the reason as text. */
  readonly cause?: unknown;
  /** A subclass's own sentence; `Agent "<agent>" failed: <cause>` by default. */
  readonly message?: string;
  readonly details?: ErrorDetails;
}

/** An agent's loop failed. */
export class AgentFailedError extends StepFailedError {
  static override readonly code: string = "step.agent";
  declare readonly code: "step.agent" | "step.agent.quality-gate" | "step.agent.invalid-answer";
  override name = "AgentFailedError";
  readonly agent: string;

  constructor(options: AgentFailedErrorOptions) {
    const { agent, usage, cause, details = {} } = options;
    super({
      message: options.message ?? `Agent "${agent}" failed: ${describe(cause)}`,
      usage,
      cause,
      ...stepCoordinatesOf(agent, ComponentKind.Agent),
      details: { agent, ...details },
    });
    this.agent = agent;
  }
}

/** One judge's rejection of an agent's reply: the judge and its verdict's `reason`. */
export interface JudgeRejection {
  readonly judge: string;
  readonly reason: string;
}

/** What a quality gate that was not passed takes. */
export interface QualityGateErrorOptions {
  readonly agent: string;
  readonly usage: readonly UsageRecord[];
  /** The judges that rejected the last reply, each with its reason. */
  readonly rejections: readonly JudgeRejection[];
  readonly retries: number;
  /** Why, when it is more than the rejections: they are the cause by default. */
  readonly cause?: unknown;
}

/** An agent's reply still failed its judges after `maxRetries` retries. */
export class QualityGateError extends AgentFailedError {
  static override readonly code = "step.agent.quality-gate" as const;
  declare readonly code: typeof QualityGateError.code;
  override name = "QualityGateError";
  /** The judges that rejected the last reply, each with its reason. */
  readonly rejections: readonly JudgeRejection[];
  readonly retries: number;

  constructor(options: QualityGateErrorOptions) {
    const { agent, usage, rejections, retries, cause } = options;
    const said = rejections.map((r) => `[${r.judge}] ${r.reason}`).join("; ");
    const reason = `quality gate not passed after ${String(retries)} retries: ${said}`;
    super({
      agent,
      usage,
      cause: cause ?? reason,
      message: `Agent "${agent}" failed: ${reason}`,
      details: { rejections: rejections.map((r) => ({ ...r })), retries },
    });
    this.rejections = rejections;
    this.retries = retries;
  }
}

/** What a guard that could not route takes. */
export interface GuardFailedErrorOptions {
  readonly guard: string;
  readonly usage: readonly UsageRecord[];
  /** Why it could not: its model did not answer, or the code guardrail threw. */
  readonly reason: string;
  /** What failed — a code guardrail's thrown error (#383); the reason itself when none. */
  readonly cause?: unknown;
}

/** A guard could not routeTo — the run fails closed instead of letting content through. */
export class GuardFailedError extends StepFailedError {
  static override readonly code = "step.guard" as const;
  declare readonly code: typeof GuardFailedError.code;
  override name = "GuardFailedError";
  readonly guard: string;
  readonly reason: string;

  constructor(options: GuardFailedErrorOptions) {
    const { guard, usage, reason, cause } = options;
    super({
      message: `Guard "${guard}" failed: ${reason}`,
      usage,
      cause: cause ?? reason,
      ...stepCoordinatesOf(guard, ComponentKind.Guardrail),
      details: { guard },
    });
    this.guard = guard;
    this.reason = reason;
  }
}
