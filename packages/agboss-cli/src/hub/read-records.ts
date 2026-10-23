import type { ExecutionHistoryRecord } from "agboss";
import { evalRunReportOf } from "agboss/internal";
import { HubInputKind, type HubEvalRun, type HubRecord } from "./hub-inputs.js";
import { FieldError, isObject, listAt, objectAt, textAt, type JsonObject } from "./json-fields.js";

/**
 * The run artifacts and the exports of kept executions the Hub reads (#401 PR 3): an artifact by
 * the framework's one reader (`evalRunReportOf`, its `kind` and `schemaVersion`); an export line by
 * line — every line `{ "kind": "agboss.execution-record", "schema": 1, …record }`, the fields the
 * Hub reads checked, a bad line named by its number.
 */

/** The export line's schema this agboss reads. */
const RECORD_SCHEMA = 1;

/** A run artifact; one this agboss does not read is a `FieldError` with the reader's reason. */
export function evalRunOf(value: JsonObject, file: string): HubEvalRun {
  const read = evalRunReportOf(value);
  if (read.kind === "invalid")
    throw new FieldError(`not a run artifact this agboss reads: ${read.reason}`);
  return { file, report: read.report };
}

/** The fields of a kept execution the Hub reads, checked; the rest kept as they are. */
function checkRecord(
  line: JsonObject,
  where: string,
): asserts line is JsonObject & ExecutionHistoryRecord {
  for (const key of ["executionId", "rootExecutionId", "tenantId", "status", "startedAt"])
    textAt(line, key, where);
  textAt(objectAt(line, "application", where), "name", `${where}.application`);
  const workflow = objectAt(line, "workflow", where);
  textAt(workflow, "name", `${where}.workflow`);
  for (const key of ["toolCalls", "steps", "children"]) listAt(line, key, where);
  if (typeof objectAt(line, "spend", where).totalUsd !== "number")
    throw new FieldError(`${where}.spend.totalUsd is not a number`);
}

/** One line of an export as a record. */
function recordOfLine(text: string, number: number): ExecutionHistoryRecord {
  const where = `line ${String(number)}`;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FieldError(`${where} is not JSON`);
  }
  if (!isObject(value) || value.kind !== HubInputKind.ExecutionRecord)
    throw new FieldError(`${where} is not an ${HubInputKind.ExecutionRecord} line`);
  if (typeof value.schema !== "number" || value.schema > RECORD_SCHEMA)
    throw new FieldError(
      `${where}: record schema ${String(value.schema)} is not one this agboss reads (${String(RECORD_SCHEMA)})`,
    );
  checkRecord(value, where);
  return value;
}

/** Every record of an export's text, in file order. */
export function recordsOf(text: string, file: string): HubRecord[] {
  return text
    .split("\n")
    .flatMap((line, index) =>
      line.trim() === "" ? [] : [{ file, record: recordOfLine(line, index + 1) }],
    );
}
