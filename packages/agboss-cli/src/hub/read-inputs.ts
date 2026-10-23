import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CliError } from "../cli/errors.js";
import { describedApplicationOf } from "./read-describe.js";
import { evalRunOf, recordsOf } from "./read-records.js";
import {
  HubInputKind,
  type DescribedApplication,
  type HubEvalRun,
  type HubInputFile,
  type HubInputs,
  type HubRecord,
} from "./hub-inputs.js";
import { FieldError, isObject } from "./json-fields.js";

/**
 * The Hub's inputs read from files and folders (#401 PR 3): a folder is read whole (its `*.json` and
 * `*.jsonl` files, sorted, any depth), a file as given. Every file says what it is by its marker;
 * one that says nothing this agboss reads, or a newer schema, is `hub.input-schema` naming it; two
 * snapshots of one application version are `hub.duplicate-application`.
 */

const MARKERS =
  "a describe --json envelope, an agboss.eval-run artifact or an agboss.execution-record export";

/** `hub.input-schema` for a file, and why. */
export const inputSchemaError = (file: string, why: string): CliError =>
  new CliError("project", "hub.input-schema", `${file}: ${why}`);

const isInputFile = (name: string): boolean => name.endsWith(".json") || name.endsWith(".jsonl");

/** Every input file under a folder, sorted, depth first. */
function filesUnder(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) return filesUnder(path);
      return entry.isFile() && isInputFile(entry.name) ? [path] : [];
    });
}

/** The files the paths name: a folder's input files, a file itself; a missing path fails. */
export function inputFilesOf(cwd: string, paths: readonly string[]): string[] {
  const files = paths.flatMap((path) => {
    const absolute = resolve(cwd, path);
    if (!existsSync(absolute))
      throw new CliError("project", "hub.input-not-found", `no file or folder ${path}`);
    return statSync(absolute).isDirectory() ? filesUnder(absolute) : [absolute];
  });
  return [...new Set(files)];
}

/** What one file held. */
type ReadFile =
  | { readonly kind: HubInputKind.Describe; readonly application: DescribedApplication }
  | { readonly kind: HubInputKind.EvalRun; readonly run: HubEvalRun }
  | { readonly kind: HubInputKind.ExecutionRecord; readonly records: readonly HubRecord[] };

/** A whole-file JSON value by its marker; one line of records is an export too. */
function jsonFileOf(value: unknown, text: string, file: string): ReadFile {
  if (!isObject(value)) return inputFail(file, `not ${MARKERS}`);
  if (value.command === "describe")
    return { kind: HubInputKind.Describe, application: describedApplicationOf(value, text, file) };
  if (value.kind === HubInputKind.EvalRun)
    return { kind: HubInputKind.EvalRun, run: evalRunOf(value, file) };
  if (value.kind === HubInputKind.ExecutionRecord)
    return { kind: HubInputKind.ExecutionRecord, records: recordsOf(text, file) };
  const kind = typeof value.kind === "string" ? ` (kind "${value.kind}")` : "";
  return inputFail(file, `not ${MARKERS}${kind}`);
}

function inputFail(file: string, why: string): never {
  throw inputSchemaError(file, why);
}

/** A file's text: one JSON value by its marker, else JSON Lines of records. */
function fileOf(text: string, file: string): ReadFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: HubInputKind.ExecutionRecord, records: recordsOf(text, file) };
  }
  return jsonFileOf(value, text, file);
}

function readFile(path: string, file: string): ReadFile {
  try {
    return fileOf(readFileSync(path, "utf8"), file);
  } catch (error) {
    if (error instanceof FieldError) throw inputSchemaError(file, error.message);
    throw error;
  }
}

/** Two snapshots of one application version: which is which is anyone's guess. */
function checkDuplicates(applications: readonly DescribedApplication[]): void {
  const seen = new Map<string, string>();
  for (const application of applications) {
    const key = `${application.name}@${application.version}`;
    const earlier = seen.get(key);
    if (earlier !== undefined)
      throw new CliError(
        "project",
        "hub.duplicate-application",
        `${application.name} ${application.version} is described twice: ${earlier} and ${application.file} — keep one snapshot per version`,
      );
    seen.set(key, application.file);
  }
}

/** Everything the paths hold, by kind. */
export function readHubInputs(cwd: string, paths: readonly string[]): HubInputs {
  const files: HubInputFile[] = [];
  const applications: DescribedApplication[] = [];
  const evalRuns: HubEvalRun[] = [];
  const records: HubRecord[] = [];
  for (const path of inputFilesOf(cwd, paths)) {
    const file = relative(cwd, path) || path;
    const read = readFile(path, file);
    if (read.kind === HubInputKind.Describe) applications.push(read.application);
    else if (read.kind === HubInputKind.EvalRun) evalRuns.push(read.run);
    else records.push(...read.records);
    const count = read.kind === HubInputKind.ExecutionRecord ? read.records.length : 1;
    files.push({ file, kind: read.kind, count });
  }
  checkDuplicates(applications);
  return { files, applications, evalRuns, records };
}
