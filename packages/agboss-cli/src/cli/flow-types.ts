import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { WorkflowLoadError } from "@agboss/core";
import {
  FlowTypesStatus,
  GENERATED_TYPES_FILE,
  writeFlowTypes,
  type FlowTypesResult,
} from "@agboss/core/internal";
import { configuredApplicationOf, type ApplicationPath } from "./application-path.js";
import { problemText, type CheckProblem } from "./check-problems.js";
import { loadOptions, type CommandContext } from "./context.js";
import { CliError } from "./errors.js";

/**
 * Type generation in the CLI (#272 S2, S7): `agboss check` on the application's module analyses its
 * workflows and writes `.agboss/types.d.ts` before it reports; `agboss generate` regenerates the file at
 * its end. A module without a workflow is a problem for `agboss check` (#376), left alone by
 * `agboss generate`.
 */

/** The `src/` folder a module lives in (the nearest ancestor of that name), if any. */
function sourceRootOf(module: string): string | undefined {
  const parts = module.split(sep);
  const at = parts.lastIndexOf("src");
  return at < 0 ? undefined : parts.slice(0, at + 1).join(sep);
}

/**
 * The module and the other workflow and application modules of its `src/` (`*.workflow.ts`,
 * `*.application.ts` — #261: an application's `defaults` and environment contract): one
 * `.agboss/types.d.ts` holds the types of every workflow of the project, so checking one keeps the
 * others'. A module outside a `src/` is generated alone.
 */
function workflowModulesOf(project: string, file: string): string[] {
  const given = resolve(project, file);
  const root = sourceRootOf(given);
  if (root === undefined) return [given];
  const found = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter(
      (path) =>
        (path.endsWith(".workflow.ts") || path.endsWith(".application.ts")) &&
        !path.split(sep).includes("node_modules"),
    )
    .map((path) => join(root, path));
  return [given, ...found.filter((path) => path !== given)];
}

/**
 * The application `package.json` sets, none when it sets none or cannot be read (a missing file, a
 * path that is not a string, invalid JSON): `--application` wins over `package.json` (#268 AC1), so
 * a broken setting there is not this check's failure — the types go to the project's file as before.
 */
function configuredApplicationOfOrNone(project: string): ApplicationPath | undefined {
  try {
    return configuredApplicationOf(project);
  } catch (error) {
    if (error instanceof CliError) return undefined;
    throw error;
  }
}

/**
 * Where the types of `file` go (#468). The project's `.agboss/types.d.ts` belongs to the application
 * its `package.json` sets (and the workflows of that `src/`): checking another application — a test
 * fixture outside `src/` — writes `.agboss/types.<module path>.d.ts` instead, so the IDE's
 * diagnostics for the project's own application are not invalidated. Undefined: the project's file.
 */
function scopedTypesFileOf(project: string, file: string): string | undefined {
  const configured = configuredApplicationOfOrNone(project);
  if (configured === undefined) return undefined;
  const given = resolve(project, file);
  const root = sourceRootOf(given);
  if (given === configured.file || (root !== undefined && root === sourceRootOf(configured.file)))
    return undefined;
  const slug = relative(project, given)
    .replace(/\.[cm]?[jt]s$/, "")
    .split(sep)
    .filter((part) => part !== "" && part !== "..")
    .join("-");
  return join(dirname(GENERATED_TYPES_FILE), `types.${slug}.d.ts`);
}

const scopedOutFile = (project: string, file: string): { readonly outFile?: string } => {
  const outFile = scopedTypesFileOf(project, file);
  return outFile === undefined ? {} : { outFile };
};

/** The generator's result for one module; undefined when it is missing. */
async function generate(
  context: CommandContext,
  file: string,
  strict = false,
): Promise<FlowTypesResult | undefined> {
  try {
    const result = await writeFlowTypes({
      files: workflowModulesOf(context.io.cwd, file),
      project: context.io.cwd,
      ...scopedOutFile(context.io.cwd, file),
      ...loadOptions(context),
      ...(strict ? { strict } : {}),
    });
    return result;
  } catch (error) {
    // a missing module is reported by the old path as workflow.load, with its own message
    if (error instanceof WorkflowLoadError) return undefined;
    throw error;
  }
}

/** The analyser's warnings (#272, #263): errors only under `--strict`. */
const WARNING_CODES: ReadonlySet<string> = new Set([
  "flow.path-too-deep",
  "graph.child-without-failure-finish",
  "judge.same-model-family",
]);

const problemsOf = (file: string, result: FlowTypesResult): readonly CheckProblem[] =>
  result.errors.map((found) => ({ file, code: found.code, message: found.message }));

/** What writing the types gave `agboss check`: its warnings and notes, and the file if written. */
export interface TypesOutcome {
  /**
   * Always reported: generation's own `types.*` problems, a write that failed
   * (`[types.not-written]`, #371) and, under `--strict`, the analyser's warnings, which are errors
   * there.
   */
  readonly problems: readonly CheckProblem[];
  /**
   * The file was not written: generation's other errors (`[dto.duplicate-name]` across workflows,
   * #371) — reported unless the assembly reports their code itself (`checkProblemsOf`).
   */
  readonly unwritten: readonly CheckProblem[];
  readonly warnings: readonly string[];
  /** The written file, relative to the project; undefined when not written. */
  readonly types?: string;
}

/** A file-system error (`EACCES`, `ENOTDIR`, …): the types file could not be written. */
const isFileSystemError = (error: unknown): error is Error =>
  error instanceof Error && "syscall" in error && typeof error.syscall === "string";

/** A failed write as a problem (#371 AC2): never `ok` when the file is not there. */
const notWritten = (file: string, error: Error): CheckProblem => ({
  file,
  code: "types.not-written",
  message: `${GENERATED_TYPES_FILE} was not written: ${error.message}`,
});

/**
 * No workflow found to type (#376): the application module exports none and the loader found no
 * workflow module beside it — never `ok`, the file was not written.
 */
const noFlow = (file: string): CheckProblem => ({
  file,
  code: "types.no-flow",
  message:
    `${GENERATED_TYPES_FILE} was not written: no workflow found to type — export the ` +
    `application's workflows from ${file} (export { MyWorkflow }), or keep it in the project's ` +
    "src/ folder beside its *.workflow.ts files",
});

/**
 * `agboss check` first writes `.agboss/types.d.ts` (#272 S7): the analyser's warnings (`[flow.path-too-deep]`)
 * and notes are reported here, generation's own problems returned; a rule violation is reported by
 * the assembly that follows (once).
 */
export async function writeCheckedTypes(
  context: CommandContext,
  application: ApplicationPath,
  strict = false,
): Promise<TypesOutcome> {
  const file = application.shown;
  const result = await generate(context, application.file, strict).catch((error: unknown) => {
    if (isFileSystemError(error)) return notWritten(file, error);
    throw error;
  });
  if (result === undefined) return { problems: [], unwritten: [], warnings: [] };
  if (!("status" in result)) return { problems: [result], unwritten: [], warnings: [] };
  if (result.status === FlowTypesStatus.NoFlow)
    return { problems: [noFlow(file)], unwritten: [], warnings: [] };
  // a rule violation is the assembly's to report; generation's own codes are `types.*` — and,
  // under --strict, the warnings the assembly does not see as errors
  const found = problemsOf(file, result);
  const isOwn = (problem: CheckProblem): boolean =>
    problem.code.startsWith("types.") || (strict && WARNING_CODES.has(problem.code));
  const problems = found.filter(isOwn);
  const warnings = [
    ...result.warnings.map((problem) => problemText({ file, ...problem })),
    ...result.notes,
  ];
  warnings.forEach((line) => {
    context.say(line);
  });
  if (result.status !== FlowTypesStatus.Written)
    return { problems, unwritten: found.filter((problem) => !isOwn(problem)), warnings };
  const types = relative(context.io.cwd, result.outFile);
  context.say(`types: ${types}`);
  return { problems, unwritten: [], warnings, types };
}

/** The end of `agboss generate`: regenerates the types of the workflow it changed, if v2. */
export async function regenerateFlowTypes(
  context: CommandContext,
  changed: readonly string[],
): Promise<void> {
  const workflow = changed.find((path) => path.endsWith(".workflow.ts"));
  if (workflow === undefined) return;
  const result = await generate(context, workflow).catch((error: unknown) => {
    // generate never validated the workflow: a module that does not load is reported, not fatal
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    context.warn(`types not regenerated: ${reason ?? ""} — run agboss check`);
    return undefined;
  });
  if (result === undefined || result.status === FlowTypesStatus.NoFlow) return;
  if (result.status === FlowTypesStatus.Written)
    context.say(`  types: ${relative(context.io.cwd, result.outFile)}`);
  else
    problemsOf(workflow, result).forEach((problem) => {
      context.warn(problemText(problem));
    });
}
