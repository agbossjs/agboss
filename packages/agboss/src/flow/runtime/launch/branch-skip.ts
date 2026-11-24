import { codeOfErrorClass, errorRecordOf, recordMatches } from "../../../core/error-record.js";
import type { ErrorRecord } from "../../../core/error-record.js";
import type { ErrorClass } from "../../ast.js";
import { FailurePolicy } from "../../decorators/router.js";
import type { BranchTicket } from "./records.js";

/**
 * Which failures drop a branch out of its join (#1279): `.onError(E, skip())` on a branch, or the
 * `Skip` policy of a router's route — one rule, kept in the branch's ticket as error codes (plain
 * JSON, so a resumed launch skips the same failures). A limit, a hand-over and a cancel never get
 * this far: the branch runner passes them on before it asks (`branch-end.ts`).
 */

/** The code of `.onError(Error, skip())`, which catches every failure. */
export const SKIP_ANY = "*";

/** The codes a ticket carries for `.onError(E, skip())`. */
export const skipCodesOf = (classes: readonly ErrorClass[]): readonly string[] =>
  classes.map((error) => codeOfErrorClass(error) ?? SKIP_ANY);

/** Whether the branch of `ticket` that failed with `thrown` (or its record) drops out of the join. */
export function isSkippedBranch(
  ticket: Pick<BranchTicket, "failure" | "skip">,
  thrown: unknown,
): boolean {
  if (ticket.failure === FailurePolicy.Skip) return true;
  if (ticket.skip === undefined || ticket.skip.length === 0) return false;
  const record: ErrorRecord = isRecord(thrown) ? thrown : errorRecordOf(thrown);
  return ticket.skip.some((code) => code === SKIP_ANY || recordMatches(record, code));
}

const isRecord = (value: unknown): value is ErrorRecord =>
  typeof value === "object" &&
  value !== null &&
  !(value instanceof Error) &&
  Array.isArray(Reflect.get(value, "lineage"));
