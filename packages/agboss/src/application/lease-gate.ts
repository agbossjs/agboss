import type { ExecutionLeaseRepository } from "../infrastructure/execution-lease.repository.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { Clock } from "../infrastructure/clock.js";

/** What a test's `leases.stall` puts around one instance's lease (#471): its store and its timers. */
export interface ExecutionLeaseGate {
  repositoryOf(repository: ExecutionLeaseRepository): ExecutionLeaseRepository;
  clockOf(clock: Clock): Clock;
}

/** The instance's infrastructure with its lease holders behind a test's gate, when it has one. */
export const gatedInfrastructure = (
  infrastructure: Infrastructure,
  gate: ExecutionLeaseGate | undefined,
): Infrastructure =>
  gate === undefined
    ? infrastructure
    : {
        ...infrastructure,
        leasing: {
          repository: gate.repositoryOf(infrastructure.executionLeases),
          clock: gate.clockOf(infrastructure.clock),
        },
      };
