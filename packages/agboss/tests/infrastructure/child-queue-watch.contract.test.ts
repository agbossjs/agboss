// #777: a queue with a watch passes the child execution queue contract, its watch cases included
// (the in-memory and SQLite queues have none: those cases check that they declare none).
import { childExecutionQueueContract } from "../../src/testing/contracts/index.js";
import { NotifyingQueueRepository } from "../fixtures/contracts/broken-stores.js";
import { inMemoryTarget } from "./contracts/store-kinds.js";

childExecutionQueueContract({
  ...inMemoryTarget(
    ({ clock, application, database }) =>
      new NotifyingQueueRepository(clock, application, database),
  ),
  name: "a queue with a watch",
});
