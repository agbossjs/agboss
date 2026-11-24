import { recordOptionKeys } from "../../components/option-keys.js";
import { WORKFLOW_FINISH_KEYS } from "../../components/decorator-options.js";
import { callerFile } from "../../components/call-site.js";
import { captureCallSite } from "../../core/diagnostics/source-span.js";
import type { DtoClass } from "../../dto/types.js";
import { NodeKind } from "../ast.js";
import type { ListWrapper } from "../dto-wrappers.js";
import { declared, recordDeclaration } from "./declaration.js";

/**
 * `@WorkflowFinish` — where an execution ends (#1271): a pure boundary port, always an empty class.
 * It passes the latest value of its `output` type on the path through; data assembled from several
 * slots or a side effect is an `@Action` before `.toFinish(…)`.
 */
export interface WorkflowFinishOptions {
  /** Ends with `-workflow-finish` (`chat-workflow-finish`). */
  readonly name: string;
  readonly description: string;
  /** One DTO, or a list of them (`listOf(ItemDto)`, `listOf(A, B)`) after a join. */
  readonly output: DtoClass | ListWrapper;
}

export function WorkflowFinish(options: WorkflowFinishOptions) {
  const source = callerFile();
  const span = captureCallSite();
  // `finish()` on the class is a compile error, like `route` on a model router
  return <TClass extends new () => object>(
    value: TClass &
      (InstanceType<TClass> extends { readonly finish: unknown }
        ? {
            readonly __error: "a finish is a pure boundary port — remove finish(), and put the work in an @Action before .toFinish(…)";
          }
        : unknown),
  ): TClass => {
    recordOptionKeys(value, "WorkflowFinish", options, WORKFLOW_FINISH_KEYS);
    recordDeclaration(value, declared(NodeKind.Finish, options, source, span));
    return value;
  };
}
