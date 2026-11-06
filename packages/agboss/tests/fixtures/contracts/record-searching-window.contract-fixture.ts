// #808: the execution record contract against a record store that finds a run's record only among
// its thread's last records.
import { randomIdGenerator } from "../../../src/infrastructure/clock.js";
import { executionRecordContract } from "../../../src/testing/contracts/index.js";
import { inMemoryTarget, sharedInMemory } from "../../infrastructure/contracts/store-kinds.js";
import { WindowSearchingRecordRepository } from "./broken-stores.js";

executionRecordContract({
  ...inMemoryTarget((seam) =>
    sharedInMemory(
      seam,
      "records",
      () => new WindowSearchingRecordRepository(seam.clock, randomIdGenerator),
    ),
  ),
  name: "a record store that looks for a run's record in its thread's last records",
});
