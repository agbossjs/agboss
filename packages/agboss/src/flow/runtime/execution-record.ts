import type { ErrorRecord } from "../../core/error-record.js";
import type { CostReport } from "../../finops/usage.js";
import type { OutdatedValueRecord, ScopeValueRecord } from "./records.js";
import type { ChildExecutionRecord } from "./child-records.js";

/**
 * The full record of one execution (#270 AC16), returned only with `app.execute(…, { record: true })`:
 * the path, every value of the path scope (with who gave it and what it was built from), the values
 * moved out of it (#271), the last handled error, the spend and its child executions, each nested
 * the same way (#263). `result.output` stays the business result only.
 */
export interface ExecutionRecord {
  readonly path: readonly string[];
  readonly scope: readonly ScopeValueRecord[];
  readonly outdatedValues: readonly OutdatedValueRecord[];
  readonly lastError?: ErrorRecord;
  readonly spend: CostReport;
  /** Its child executions that ended — finished, failed or cancelled — nested (#263). */
  readonly children: readonly ChildExecutionRecord[];
}
