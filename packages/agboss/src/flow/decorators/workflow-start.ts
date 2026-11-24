import { recordOptionKeys } from "../../components/option-keys.js";
import { WORKFLOW_START_KEYS } from "../../components/decorator-options.js";
import { callerFile } from "../../components/call-site.js";
import { captureCallSite } from "../../core/diagnostics/source-span.js";
import type { Class } from "../../components/injection.js";
import type { DtoClass } from "../../dto/types.js";
import { NodeKind } from "../ast.js";
import type { ListWrapper, ValueShape } from "../dto-wrappers.js";
import { declared, recordDeclaration } from "./declaration.js";

/** What a start takes: one DTO, a list of them, or a map of fields (#270) — never a `historyOf`. */
export type WorkflowStartInput =
  DtoClass | ListWrapper<DtoClass> | Readonly<Record<string, ValueShape>>;

/** `@WorkflowStart` — where an execution starts; in the flow `onStart(S).toAgent(…)`. */
export interface WorkflowStartOptions {
  /** Ends with `-workflow-start` (`chat-workflow-start`). */
  readonly name: string;
  readonly description: string;
  readonly input: WorkflowStartInput;
}

/** The class is empty: `app.execute(S, payload)` is typed by the generated `InputOf<S>`. */
export function WorkflowStart(options: WorkflowStartOptions) {
  const source = callerFile();
  const span = captureCallSite();
  return <TClass extends Class>(value: TClass): TClass => {
    recordOptionKeys(value, "WorkflowStart", options, WORKFLOW_START_KEYS);
    recordDeclaration(value, declared(NodeKind.Start, options, source, span));
    return value;
  };
}
