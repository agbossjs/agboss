import { nodeRecordIn } from "../flow/runtime/workflow-keys.js";
import { storedOutputOf } from "../pii/final-output-mask.js";
import type { AppDeps } from "./app-deps.js";
import type { ExecutionHistoryRecord } from "../infrastructure/execution-history.repository.js";
import type { RecordedState } from "./execution-history.js";

/**
 * What a history record says of the finish: nothing unless it finished. The output is stored, so
 * its finish DTO's sensitive fields are masked (#1301).
 */
export const finishPartOf = (
  deps: AppDeps,
  values: RecordedState,
): Partial<Pick<ExecutionHistoryRecord, "finish" | "output">> =>
  values.finish === ""
    ? {}
    : {
        finish: nodeRecordIn(deps, values.finish),
        output: storedOutputOf(deps, values.finish, values.output),
      };
