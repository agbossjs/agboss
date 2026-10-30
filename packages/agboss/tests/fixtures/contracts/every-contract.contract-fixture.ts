// #481 AC1: every published suite against one target name, as an outside store's own run sees it.
import { randomIdGenerator } from "../../../src/infrastructure/clock.js";
import { InMemoryCheckpointSaver } from "../../../src/infrastructure/contracts.js";
import { InMemoryChildExecutionQueueRepository } from "../../../src/infrastructure/child-execution-queue.repository.js";
import { InMemoryCostLedgerRepository } from "../../../src/infrastructure/cost-ledger.repository.js";
import { InMemoryExecutionHistoryRepository } from "../../../src/infrastructure/execution-history.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { InMemoryExecutionRecordRepository } from "../../../src/infrastructure/execution-record.repository.js";
import { InMemoryExecutionTreeRepository } from "../../../src/infrastructure/execution-tree.repository.js";
import { InMemoryMeshRequestRepository } from "../../../src/infrastructure/mesh-request.repository.js";
import { InMemoryPausedExecutionRepository } from "../../../src/infrastructure/paused-execution.repository.js";
import { InMemoryRateLimitRepository } from "../../../src/infrastructure/rate-limit.repository.js";
import {
  checkpointSaverContract,
  childExecutionQueueContract,
  costLedgerContract,
  executionHistoryContract,
  executionLeaseContract,
  executionRecordContract,
  executionTreeContract,
  fencedEffectContract,
  meshRequestContract,
  pausedExecutionContract,
  rateLimitContract,
  type ContractTarget,
} from "../../../src/testing/contracts/index.js";
import { inMemoryFencedEffects } from "../../infrastructure/contracts/fenced-effect-stores.js";
import {
  inMemoryTarget,
  sharedInMemory,
  type StoreFactory,
} from "../../infrastructure/contracts/store-kinds.js";

/** The core's in-memory store, under the name an outside store would give its target. */
const fixtureStore = <TStore>(make: StoreFactory<TStore>): ContractTarget<TStore> => ({
  ...inMemoryTarget(make),
  name: "fixture-store",
});

checkpointSaverContract(
  fixtureStore((seam) => sharedInMemory(seam, "checkpoints", () => new InMemoryCheckpointSaver())),
);
childExecutionQueueContract(
  fixtureStore(
    ({ clock, application, database }) =>
      new InMemoryChildExecutionQueueRepository(clock, application, database),
  ),
);
costLedgerContract(
  fixtureStore((seam) => sharedInMemory(seam, "ledger", () => new InMemoryCostLedgerRepository())),
);
executionHistoryContract(
  fixtureStore(({ database }) => new InMemoryExecutionHistoryRepository(database)),
);
executionLeaseContract(
  fixtureStore(
    ({ clock, application, database }) =>
      new InMemoryExecutionLeaseRepository(clock, application, database),
  ),
);
executionRecordContract(
  fixtureStore((seam) =>
    sharedInMemory(
      seam,
      "records",
      () => new InMemoryExecutionRecordRepository(seam.clock, randomIdGenerator),
    ),
  ),
);
executionTreeContract(
  fixtureStore(({ database }) => new InMemoryExecutionTreeRepository(database)),
);
fencedEffectContract(fixtureStore(inMemoryFencedEffects(false)));
meshRequestContract(fixtureStore(({ database }) => new InMemoryMeshRequestRepository(database)));
pausedExecutionContract(
  fixtureStore((seam) =>
    sharedInMemory(seam, "paused", () => new InMemoryPausedExecutionRepository()),
  ),
);
rateLimitContract(
  fixtureStore(
    ({ clock, application, database }) =>
      new InMemoryRateLimitRepository(clock, application, database),
  ),
);
