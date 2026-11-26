import { PauseExpiryBound } from "../../infrastructure/pause-record.js";
import {
  NO_RECIPIENTS,
  type PauseReassignmentChange,
  type PauseRecipients,
} from "../../infrastructure/pause-notices.js";
import {
  type PausedExecutionRepository,
  type PauseRecord,
} from "../../infrastructure/paused-execution.repository.js";
import type { ContractInstances } from "./instance-context.js";
import {
  BEFORE_DEADLINE,
  expiringPauseOf,
  LISTENER_KEYS,
  RECIPIENTS,
  withSeenNow,
} from "./paused-execution-data.js";

/** What the reassignment cases (#946) share: the stores, a quorum branch, the reassignment call. */
export type Instances = ContractInstances<PausedExecutionRepository>;
export type Store = PausedExecutionRepository;
export const R = NO_RECIPIENTS;
export const [AUDIT, SLACK] = LISTENER_KEYS;

/** The pause `pause-a` with a deadline and a reminder, branches and a bound, as a quorum's branch has. */
export const branchOf = (pauseId: string, stepKey = "run-1:clerk-agent:1:call-1"): PauseRecord => ({
  ...expiringPauseOf(pauseId, stepKey),
  expiryBound: PauseExpiryBound.Quorum,
  boundAt: "2026-01-05T11:00:00.000Z",
  branchKeys: ["run-1:refund-one-workflow:1:0", "child-1:clerk-agent:1"],
});

export const reassign = async (
  store: Store,
  pauseId: string,
  replacementId: string,
  at: Date = BEFORE_DEADLINE,
  assignees: readonly string[] = ["deputy-3"],
): Promise<PauseRecord | undefined> =>
  store.reassignByTenantIdAndPauseId(
    "default",
    pauseId,
    await withSeenNow(store, pauseId, { pauseId: replacementId, assignees }),
    at,
    RECIPIENTS,
  );

/** A reassignment as a caller makes it, before the plan names what it is made against. */
type Unplanned<C> = C extends PauseReassignmentChange ? Omit<C, "seen"> : never;

/** A reassignment of `pauseId` planned against the pause as it is now: `change` plus the `seen` read at this moment. */
export const reassignWith = async (
  store: Store,
  pauseId: string,
  change: Unplanned<PauseReassignmentChange>,
  at: Date = BEFORE_DEADLINE,
  recipients: PauseRecipients = RECIPIENTS,
): Promise<PauseRecord | undefined> =>
  store.reassignByTenantIdAndPauseId(
    "default",
    pauseId,
    await withSeenNow(store, pauseId, change),
    at,
    recipients,
  );

export const treeOf = async (store: Store): Promise<readonly PauseRecord[]> =>
  store.findAllByTenantIdAndRootExecutionId("default", "run-1");

export const ids = (pauses: readonly PauseRecord[]): string[] =>
  pauses.map((p) => p.pauseId).sort();

/** The one of two racing outcomes that applied: exactly one is a record. */
export const winners = (outcomes: readonly (PauseRecord | undefined)[]): number =>
  outcomes.filter((one) => one !== undefined).length;
