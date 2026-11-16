import type { ExecutionHistoryRecord } from "../../infrastructure/execution-history.repository.js";
import { StoreHoldPoint, type StoreMethod } from "./store-points.js";

/** The history store's save: the record of a root, by its execution. */
export const HISTORY_METHODS: Readonly<Record<string, StoreMethod>> = {
  save: {
    point: StoreHoldPoint.HistorySave,
    keyOf: (args) => (args[0] as ExecutionHistoryRecord).executionId,
    inputOf: (args) => ({ status: (args[0] as ExecutionHistoryRecord).status }),
    outputOf: (result) => (result === undefined ? null : result),
  },
};
