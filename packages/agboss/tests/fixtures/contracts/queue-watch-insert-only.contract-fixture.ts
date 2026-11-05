// #777: the child execution queue contract against a queue whose watch misses a child queued again.
import { childExecutionQueueContract } from "../../../src/testing/contracts/index.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { InsertOnlyNotifyingQueueRepository } from "./broken-stores.js";

childExecutionQueueContract({
  ...inMemoryTarget(
    ({ clock, application, database }) =>
      new InsertOnlyNotifyingQueueRepository(clock, application, database),
  ),
  name: "a queue whose watch misses a child queued again",
});
