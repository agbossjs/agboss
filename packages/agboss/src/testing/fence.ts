import { ExecutionLeaseLostError, scopeKeyOf } from "../app/lease-lost.js";
import type { FrameLease } from "../flow/context/frame.js";
import type { Clock } from "../infrastructure/clock.js";
import { EXECUTION_LEASE } from "../app/lease-fence.js";

/**
 * The fence of a unit test's step (#471): `executionContext.fence` in a unit runner (`testAction`,
 * `testTool`, …) and in `testExecutionContext()`. By default the lease is held — token 1, the
 * execution's own lease scope, confirmed until the runner's clock plus the lease's 30 s; each field
 * may be set, and `isLost` / `confirmNowFails` make its checks refuse as a lost lease does.
 */
export interface TestFenceOptions {
  /** `fence.token`; default 1. */
  readonly token?: number;
  /** `fence.leaseExecutionId`; default the execution's id. */
  readonly leaseExecutionId?: string;
  /** `fence.confirmedUntil`; default the clock's now + 30 s. */
  readonly confirmedUntil?: Date;
  /** The lease was lost: `assertHeld()` throws and `confirmNow()` rejects with `ExecutionLeaseLostError`. */
  readonly isLost?: boolean;
  /**
   * Only `confirmNow()` rejects (a store error before an irreversible call): with
   * `ExecutionLeaseLostError` when `true`, else the error given.
   */
  readonly confirmNowFails?: true | Error;
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
  const confirmedUntil = (
    options.confirmedUntil ?? new Date(site.clock.now().getTime() + EXECUTION_LEASE)
  ).getTime();
  const lost = (): ExecutionLeaseLostError => new ExecutionLeaseLostError(leaseExecutionId);
  return Object.freeze({
    tenantId: site.tenantId,
    leaseExecutionId,
    scopeKey: scopeKeyOf(site.tenantId, leaseExecutionId),
    token: options.token ?? 1,
    confirmedUntil,
    isYielded: false,
    assertHeld: (): void => {
      if (options.isLost === true || site.clock.now().getTime() >= confirmedUntil) throw lost();
    },
    confirmNow: (): Promise<void> => {
      if (options.isLost === true) return Promise.reject(lost());
      const fails = options.confirmNowFails;
      if (fails === undefined) return Promise.resolve();
      return Promise.reject(fails === true ? lost() : fails);
    },
    enterStep: (): Promise<() => void> => Promise.resolve(() => undefined),
  });
}
