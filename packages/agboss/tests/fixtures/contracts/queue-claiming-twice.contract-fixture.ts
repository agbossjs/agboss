// #481 AC2: the child execution queue contract against a queue that claims the same row twice.
import { childExecutionQueueContract } from "../../../src/testing/contracts/index.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { TwiceClaimingQueueRepository } from "./broken-stores.js";

childExecutionQueueContract({
  ...inMemoryTarget(
    ({ clock, application, database }) =>
      new TwiceClaimingQueueRepository(clock, application, database),
  ),
  name: "a queue that claims a row twice",
});
