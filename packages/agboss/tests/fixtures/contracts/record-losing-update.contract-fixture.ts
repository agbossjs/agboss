// #481 AC2: the execution record contract against a record store that loses an update.
import { randomIdGenerator } from "../../../src/infrastructure/clock.js";
import { executionRecordContract } from "../../../src/testing/contracts/index.js";
import { inMemoryTarget, sharedInMemory } from "../../infrastructure/contracts/store-kinds.js";
import { UpdateLosingRecordRepository } from "./broken-stores.js";

executionRecordContract({
  ...inMemoryTarget((seam) =>
    sharedInMemory(
      seam,
      "records",
      () => new UpdateLosingRecordRepository(seam.clock, randomIdGenerator),
    ),
  ),
  name: "a record store that loses an update",
});
