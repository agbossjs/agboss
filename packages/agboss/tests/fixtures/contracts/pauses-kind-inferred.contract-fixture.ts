// 0.1.1: the paused-execution contract against a store that infers a pause's kind from its component.
import { pausedExecutionContract } from "../../../src/testing/contracts/index.js";
import { inMemoryTarget, sharedInMemory } from "../../infrastructure/contracts/store-kinds.js";
import { KindInferredPausedExecutionRepository } from "./kind-inferred-pauses.js";

pausedExecutionContract({
  ...inMemoryTarget((seam) =>
    sharedInMemory(seam, "kind-inferred-paused", () => new KindInferredPausedExecutionRepository()),
  ),
  name: "a pause store that infers a pause's kind from its component",
});
