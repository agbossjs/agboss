/**
 * Public API of the Turns module (run records, threads, scores). Everything outside src/turns
 * imports from here only (lint-enforced); the module depends on nothing else in src.
 */
export { createSqliteTurnStore, sharedTurnStore, type ThreadIds } from "./sqlite-store.js";
/** The Turn database itself (opened and migrated), for stores that share it (paused runs, #201). */
export { openTurnDatabase } from "./schema.js";
export { pauseAnswerEntryOf } from "./writes.js";
// the status history of a thread (#1341d)
export {
  recordTransitionOf,
  StatusTrigger,
  ThreadStatus,
  transitionOf,
  type NewStatusTransition,
  type StatusContext,
  type ThreadStatusTransition,
} from "./status-transition.js";
export { memoryStatusLog, sqliteStatusLog, type StatusLog } from "./status-log.js";
export { STATUS_TRANSITIONS_SCHEMA } from "./status-transition-schema.js";
export {
  TURN_STATUSES,
  type NewTurn,
  type Turn,
  type TurnStatus,
  type TurnStep,
  type ConfigSnapshot,
  type ConfigStore,
  type EndedRun,
  type MemoryStore,
  type NewSummary,
  type NewThread,
  type Summary,
  type TurnOutcome,
  type TurnStore,
  type PauseAnswerEntry,
  type TurnRecords,
  type TurnTree,
  type VersionScore,
} from "./types.js";
export {
  NonJsonValueError,
  SHORT_VERSION_LENGTH,
  shortVersion,
  stableJson,
  versionOf,
} from "./versions.js";
