// #746: the paused-execution contract against a store that reads back only an approval's ask.
import { pausedExecutionContract } from "../../../src/testing/contracts/index.js";
import { inMemoryTarget, sharedInMemory } from "../../infrastructure/contracts/store-kinds.js";
import { ApprovalOnlyPausedExecutionRepository } from "./approval-only-pauses.js";

pausedExecutionContract({
  ...inMemoryTarget((seam) =>
    sharedInMemory(seam, "approval-only-paused", () => new ApprovalOnlyPausedExecutionRepository()),
  ),
  name: "a pause store that reads an approval's ask only",
});
