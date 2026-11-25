/**
 * What #1324 keeps out of the public API: the checkpoint savers' LangGraph-typed surface —
 * `@agboss/core/stores` holds only the pure functions (`stepOf`, `NO_STEP`, …), so no LangGraph type
 * reaches its API report — and the describe data of an assembled application, which the CLI prints
 * with its `--env` environment (`@agboss/core/describe` takes the class and assembles it itself).
 */
export { applicationDataOf, workflowDataOf } from "./describe/describe-data.js";
export { SqliteCheckpointSaver } from "./infrastructure/sqlite/sqlite-checkpoint-saver.js";
export {
  hasLatestByStep,
  type LatestByStepCheckpointSaver,
} from "./infrastructure/latest-by-step.js";
