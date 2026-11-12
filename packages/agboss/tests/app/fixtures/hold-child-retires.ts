import { ExecutionLeaseRepository, type ExecutionLease } from "../../../src/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";

/** The child's retires held, and how to let them go. */
export interface RetireHold {
  readonly held: ExecutionLease[];
  release(): void;
}

/** Holds every retire of a lease that is not `rootId`'s (the child's) until `release()`. */
export function holdChildRetires(
  apps: readonly TestApp[],
  rootId: () => string | undefined,
): RetireHold {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held: ExecutionLease[] = [];
  for (const app of apps) {
    const leases = app.resolve(ExecutionLeaseRepository);
    const retire = leases.retire.bind(leases);
    leases.retire = async (lease) => {
      if (lease.rootExecutionId === rootId()) return retire(lease);
      held.push(lease);
      await released;
      return retire(lease);
    };
  }
  return { held, release };
}
