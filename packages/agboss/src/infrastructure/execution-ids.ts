import { DuplicateExecutionIdError } from "../core/errors.js";
import { CheckedIdGenerator, randomIdGenerator, type IdGenerator } from "./clock.js";
import type { ExecutionLeaseRepository } from "./execution-lease.repository.js";

/**
 * How the framework makes a new execution's id (#591) — a root, a child, a recursion level: the
 * application's `IdGenerator` mints it (checked, #578) and the lease store keeps it
 * (`saveExecutionIdIfAbsent`) before anything else of the execution is written — its budgets'
 * amounts, its thread, its lease, its marker, its checkpoint. An id another execution ever had is
 * `DuplicateExecutionIdError`: two trees never share a lease, a fencing token, a lease log or a step
 * key, whatever the generator does. A resume and a recovery keep their id and never come here.
 */
export interface ExecutionIds {
  /** A new execution's id for `tenantId`, kept; `DuplicateExecutionIdError` when it was taken. */
  newExecutionId(tenantId: string): Promise<string>;
}

/** The class a refusal names: the project's own generator, not the framework's check around it. */
const generatorNameOf = (idGenerator: IdGenerator): string =>
  (idGenerator instanceof CheckedIdGenerator ? idGenerator.minting : idGenerator).constructor.name;

/** The ids of an application instance: minted by `idGenerator`, kept in `leases`. */
export const executionIdsOf = (
  idGenerator: IdGenerator,
  leases: Pick<ExecutionLeaseRepository, "saveExecutionIdIfAbsent">,
): ExecutionIds => ({
  async newExecutionId(tenantId: string): Promise<string> {
    const executionId = idGenerator.newExecutionId();
    if (await leases.saveExecutionIdIfAbsent({ executionId, tenantId })) return executionId;
    throw new DuplicateExecutionIdError(generatorNameOf(idGenerator));
  },
});

/** A graph run with no application (no store to keep ids in): random ids, kept nowhere. */
export const unkeptExecutionIds: ExecutionIds = {
  newExecutionId: () => Promise.resolve(randomIdGenerator.newExecutionId()),
};
