// #720: the child execution queue contract against a queue whose claim marks two rows, answers one.
import { childExecutionQueueContract } from "../../../src/testing/contracts/index.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { RowsSweepingQueueRepository } from "./broken-stores.js";

childExecutionQueueContract({
  ...inMemoryTarget(
    ({ clock, application, database }) =>
      new RowsSweepingQueueRepository(clock, application, database),
  ),
  name: "a queue whose claim marks two rows",
});
