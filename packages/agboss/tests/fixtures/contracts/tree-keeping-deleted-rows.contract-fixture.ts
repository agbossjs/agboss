// #481 AC2: the execution tree contract against a tree store whose delete leaves rows.
import { executionTreeContract } from "../../../src/testing/contracts/index.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { RowKeepingTreeRepository } from "./broken-stores.js";

executionTreeContract({
  ...inMemoryTarget(({ database }) => new RowKeepingTreeRepository(database)),
  name: "a tree store that keeps deleted rows",
});
