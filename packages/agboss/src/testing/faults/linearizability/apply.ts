import {
  acquired,
  leaseStateAt,
  reclaimed,
  released,
  renewed,
  treeOf,
  yielded,
  type FencingState,
  type LeaseAnswer,
  type ModelStep,
} from "../../contracts/models/lease-model.js";
import { StoreHoldPoint } from "../store-points.js";
import { UNKNOWN, type CheckedOperation } from "./operations.js";
import { callApplied, callKeyOf, isSame } from "./apply-calls.js";

/**
 * One recorded operation on the sequential model (#533 item 5): the model's next state, and
 * whether what the store answered is what the model says — an unknown answer is any answer.
 */

/** The lease the history says a lease operation is held with. */
interface HeldFacts {
  readonly tenantId: string;
  readonly rootExecutionId: string;
  readonly holderInstanceId: string;
  readonly leaseEpoch: number;
  readonly lease?: number;
}

/** The lease asked for when the history did not keep it: the framework's 30 s. */
const DEFAULT_LEASE = 30_000;

/** A store's lease answer as the model's. */
const leaseAnswerOf = (output: unknown): LeaseAnswer => {
  if (output === null || typeof output !== "object") return null;
  const { leaseEpoch, holderInstanceId } = output as {
    leaseEpoch: number;
    holderInstanceId: string;
  };
  return { epoch: leaseEpoch, holder: holderInstanceId };
};

/** The result of one step: the next state when the store's answer is the model's. */
export type Applied = FencingState | undefined;

/** A lease answer as the model compares it, an unseen one unknown. */
const leaseOutputOf = (output: unknown): unknown =>
  output === UNKNOWN ? UNKNOWN : leaseAnswerOf(output);

/** A renewal's answer (the time left, or none) as the model compares it: whether it renewed. */
const renewedOutputOf = (output: unknown): unknown =>
  output === UNKNOWN ? UNKNOWN : output !== null;

/** Each lease operation: the model's step, and how the store's answer compares with its answer. */
const LEASE_STEPS: Readonly<
  Record<
    string,
    (
      state: FencingState,
      held: HeldFacts,
      operation: CheckedOperation,
      now: number,
    ) => readonly [ModelStep<unknown>, unknown, unknown]
  >
> = {
  [StoreHoldPoint.LeaseAcquire]: (state, held, operation, now) => {
    const step = acquired(
      state,
      treeOf(held.tenantId, held.rootExecutionId),
      operation.holder,
      held.lease ?? DEFAULT_LEASE,
      now,
    );
    return [step, leaseOutputOf(operation.output), step.answer];
  },
  [StoreHoldPoint.LeaseRenew]: (state, held, operation, now) => {
    const step = renewed(
      state,
      treeOf(held.tenantId, held.rootExecutionId),
      held.holderInstanceId,
      held.leaseEpoch,
      held.lease ?? DEFAULT_LEASE,
      now,
    );
    return [step, renewedOutputOf(operation.output), step.answer !== null];
  },
  [StoreHoldPoint.LeaseYield]: (state, held, operation, now) => {
    const step = yielded(
      state,
      treeOf(held.tenantId, held.rootExecutionId),
      held.holderInstanceId,
      held.leaseEpoch,
      now,
    );
    return [step, operation.output, step.answer];
  },
  [StoreHoldPoint.LeaseReclaim]: (state, held, operation, now) => {
    const step = reclaimed(
      state,
      treeOf(held.tenantId, held.rootExecutionId),
      held.holderInstanceId,
      held.leaseEpoch,
      held.lease ?? DEFAULT_LEASE,
      now,
    );
    return [step, leaseOutputOf(operation.output), step.answer];
  },
};

function leaseApplied(state: FencingState, operation: CheckedOperation, now: number): Applied {
  const held = operation.input as unknown as HeldFacts;
  const step = LEASE_STEPS[operation.kind];
  if (step === undefined) {
    const isFinish = operation.kind === StoreHoldPoint.LeaseFinish;
    return released(
      state,
      treeOf(held.tenantId, held.rootExecutionId),
      held.holderInstanceId,
      held.leaseEpoch,
      isFinish,
    ).state;
  }
  const [taken, output, answer] = step(state, held, operation, now);
  return isSame(output, answer) ? taken.state : undefined;
}

/** The lease operations, by their point. */
const LEASE_KINDS: ReadonlySet<string> = new Set([
  StoreHoldPoint.LeaseAcquire,
  StoreHoldPoint.LeaseRenew,
  StoreHoldPoint.LeaseRelease,
  StoreHoldPoint.LeaseFinish,
  StoreHoldPoint.LeaseYield,
  StoreHoldPoint.LeaseReclaim,
]);

/** `operation` taking effect at `now` on `state`: the next state, or `undefined` when the store's answer is not the model's. */
export function applied(state: FencingState, operation: CheckedOperation, now: number): Applied {
  if (LEASE_KINDS.has(operation.kind)) return leaseApplied(state, operation, now);
  if (operation.kind === StoreHoldPoint.OutboundLeaseStateOf) {
    const lease = operation.input as { tenantId: string; leaseExecutionId: string; token: number };
    const step = leaseStateAt(
      state,
      treeOf(lease.tenantId, lease.leaseExecutionId),
      lease.token,
      now,
    );
    return isSame(operation.output, step.answer) ? step.state : undefined;
  }
  return callApplied(state, operation, now);
}

/** The objects `operation` touches: its tree, its scope, its call's identity — what partitions a history. */
export function objectsOf(operation: CheckedOperation): readonly string[] {
  const input = operation.input as {
    tenantId?: string;
    rootExecutionId?: string;
    leaseExecutionId?: string;
    scopeKey?: string;
  };
  const tenant = input.tenantId ?? "default";
  if (LEASE_KINDS.has(operation.kind))
    return [`tree:${treeOf(tenant, input.rootExecutionId ?? "")}`];
  const tree = `tree:${treeOf(tenant, input.leaseExecutionId ?? "")}`;
  if (operation.kind === StoreHoldPoint.OutboundLeaseStateOf) return [tree];
  return [tree, `call:${callKeyOf(operation.input).identity}`];
}
