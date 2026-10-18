import { callerFile } from "../../components/call-site.js";
import type { Class } from "../../components/injection.js";
import type { DtoClass } from "../../dto/types.js";
import { NodeKind } from "../ast.js";
import type { ListWrapper, ValueShape } from "../dto-wrappers.js";
import { declared, recordDeclaration } from "./declaration.js";

/** What a start takes: one DTO, a list of them, or a map of fields (#270) — never a `historyOf`. */
export type WorkflowStartInput =
  DtoClass | ListWrapper<DtoClass> | Readonly<Record<string, ValueShape>>;

/** `@WorkflowStart` — where an execution starts; in the flow `start(S).returns(InputDto)`. */
export interface WorkflowStartOptions {
  /** Ends with `-workflow-start` (`chat-workflow-start`). */
  readonly name: string;
  readonly description: string;
  readonly input: WorkflowStartInput;
}

/** The class is empty: `app.execute(S, payload)` is typed by the generated `InputOf<S>`. */
export function WorkflowStart(options: WorkflowStartOptions) {
  const source = callerFile();
  return <TClass extends Class>(value: TClass): TClass => {
    recordDeclaration(value, declared(NodeKind.Start, options, source));
    return value;
  };
}
