import type { HandledErrorRecord } from "./child-records.js";
import type { RuntimeNode } from "./graph-model.js";
import type { SidePathRecord } from "./limits.js";
import type { ExecutionStateType } from "./state.js";

/**
 * The failure the `.onError` side path a visit is on took in (#1316f), for the visit's frame
 * (`executionContext.handledError`). A launch's branch reads its launcher's path.
 */
export function handledErrorFrame(
  state: ExecutionStateType,
  node: RuntimeNode,
  isBranch = false,
): { readonly handledError?: HandledErrorRecord } {
  const on: SidePathRecord | null | undefined = state.sidePath;
  const handled = (on != null && (isBranch || on.next === node.id) ? on : null)?.handled;
  return handled === undefined ? {} : { handledError: handled };
}
