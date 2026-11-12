import { ExecutionLeaseLostError, scopeKeyOf } from "../app/lease-lost.js";
import type { FrameLease } from "../flow/context/frame.js";
import type { Clock } from "../infrastructure/clock.js";
import { EXECUTION_LEASE } from "../app/lease-fence.js";

/**
 * The fence of a unit test's step (#471): `executionContext.fence` in a unit runner (`testAction`,
 * `testTool`, …) and in `testExecutionContext()`. By default the lease is held — token 1, the
 * execution's own lease scope, confirmed until the runner's clock plus the lease's 30 s; each field
 * may be set, and `isLost` / `renewNowFails` make its checks refuse as a lost lease does.
 */
export interface TestFenceOptions {
  /** `fence.token`; default 1. */
  readonly token?: number;
  /** `fence.leaseExecutionId`; default the execution's id. */
  readonly leaseExecutionId?: string;
  /** `fence.trustedUntil`; default the clock's now + 30 s. */
  readonly trustedUntil?: Date;
  /** The lease was lost: `assertHeld()` throws and `renewNow()` rejects with `ExecutionLeaseLostError`. */
  readonly isLost?: boolean;
  /**
   * Only `renewNow()` rejects (a store error before an irreversible call): with
   * `ExecutionLeaseLostError` when `true`, the error given when an `Error`; `false` (the default)
   * resolves.
   */
  readonly renewNowFails?: boolean | Error;
}

/** Where a unit test's fence stands: its tenant, its execution and the clock of its runner. */
export interface TestFenceSite {
  readonly tenantId: string;
  readonly executionId: string;
  readonly clock: Clock;
}

/** The held lease a unit test's frame fences with. */
export function testFenceLeaseOf(options: TestFenceOptions, site: TestFenceSite): FrameLease {
  const leaseExecutionId = options.leaseExecutionId ?? site.executionId;
  const trustedUntil = (
    options.trustedUntil ?? new Date(site.clock.now().getTime() + EXECUTION_LEASE)
  ).getTime();
  const lost = (): ExecutionLeaseLostError =>
    new ExecutionLeaseLostError({ rootExecutionId: leaseExecutionId });
  return Object.freeze({
    tenantId: site.tenantId,
    leaseExecutionId,
    scopeKey: scopeKeyOf(site.tenantId, leaseExecutionId),
    token: options.token ?? 1,
    trustedUntil,
    isYielded: false,
    assertHeld: (): void => {
      if (options.isLost === true || site.clock.now().getTime() >= trustedUntil) throw lost();
    },
    renewNow: (): Promise<void> => {
      if (options.isLost === true) return Promise.reject(lost());
      const fails = options.renewNowFails;
      if (fails === undefined || fails === false) return Promise.resolve();
      return Promise.reject(fails === true ? lost() : fails);
    },
    enterStep: (): Promise<() => void> => Promise.resolve(() => undefined),
  });
}
