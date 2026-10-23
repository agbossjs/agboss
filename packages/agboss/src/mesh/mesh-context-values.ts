import type { ExecutionOptions } from "../app/types.js";
import { deadlineFrom, earliestOf, withExecutionDeadline } from "../budgets/execution-deadline.js";
import type { ExecutionContextValues } from "../flow/context/context-values.js";
import { inboundMeshOf, withInboundChain } from "./inbound-mesh.js";

/**
 * A new execution's context values with what the mesh adds (#398): the call chain its transport
 * admitted, and its deadline — `execute(…, { deadline })` or a trusted caller's time left, the
 * smaller one — fixed on the `Clock` at `now`.
 */
export function meshContextValuesOf(
  values: ExecutionContextValues,
  call: ExecutionOptions,
  now: Date,
): ExecutionContextValues {
  const inbound = inboundMeshOf(call);
  const deadline = deadlineFrom(now, earliestOf(call.deadline, inbound?.trusted?.deadline));
  return withExecutionDeadline(withInboundChain(values, inbound), deadline);
}
