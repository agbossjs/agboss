import type { FaultRun } from "../facts.js";
import type { OperationHistory } from "../operation-history.js";
import { FaultInvariant, violation, type FaultViolation } from "../invariants/violations.js";
import { checkedOperationsOf, UNKNOWN, type CheckedOperation } from "./operations.js";
import { notLinearizable, type NotLinearizable } from "./search.js";

/**
 * The linearizability checker (#533 item 5): a fault run's store history — every held operation's
 * invoke and complete — against the sequential model of the fencing stores
 * (`src/testing/contracts/models/`): one order of the operations, each taking effect at one instant
 * of its span, in which every answer is the model's. A run's `faultViolationsOf` reports a part
 * with none as `linearizable`, with the longest prefix found and what could not follow it.
 */

/** How the history's machine time maps to the store's. */
export interface LinearizabilityOptions {
  /** How much faster than real time the store's clock runs: the fault suite's `timeScale`. */
  readonly timeScale?: number;
  /** Store ms each span is widened by, for the two clocks' reading jitter; default 5 × the scale. */
  readonly slack?: number;
}

/** The parts of `history` no order explains. */
export function linearizabilityOf(
  history: OperationHistory,
  options: LinearizabilityOptions = {},
): NotLinearizable[] {
  const scale = options.timeScale ?? 1;
  return notLinearizable(checkedOperationsOf(history, scale, options.slack ?? 5 * scale));
}

/** One operation as a violation names it. */
const textOf = (operation: CheckedOperation): string => {
  const output = operation.output === UNKNOWN ? "unknown" : JSON.stringify(operation.output);
  return `${operation.id} ${operation.kind} by ${operation.holder} ${JSON.stringify(operation.input)} → ${output}`;
};

/** A part with no linearization, said plainly. */
const messageOf = (part: NotLinearizable): string =>
  [
    `${String(part.operations.length)} operations have no order the sequential model explains`,
    `the longest order found (${String(part.longest.length)}): ${part.longest.map((operation) => operation.id).join(", ") || "none"}`,
    `none of these can follow it: ${part.stuck.map(textOf).join("; ")}`,
  ].join(" — ");

/** The `linearizable` violations of a fault run. */
export function linearizabilityViolations(run: FaultRun): FaultViolation[] {
  return linearizabilityOf(run.history, { timeScale: run.timeScale ?? 1 }).map((part) =>
    violation(FaultInvariant.Linearizable, messageOf(part)),
  );
}
