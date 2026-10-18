import { readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { WorkflowLoadError } from "agboss";
import { FlowTypesStatus, writeFlowTypes, type FlowTypesResult } from "agboss/internal";
import { problemText, type CheckProblem } from "./check-problems.js";
import { loadOptions, type CommandContext } from "./context.js";

/**
 * Type generation in the CLI (#272 S2, S7): `agboss check` on a module with v2 workflows analyses
 * them and writes `.agboss/types.d.ts` before it reports; `agboss generate` regenerates the file at
 * its end. A module without a workflow goes the old way, untouched.
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

/** The generator's result for one module; undefined when it holds no v2 workflow or is missing. */
async function generate(
  context: CommandContext,
  file: string,
): Promise<FlowTypesResult | undefined> {
  try {
    const result = await writeFlowTypes({
      files: workflowModulesOf(context.io.cwd, file),
      project: context.io.cwd,
      ...loadOptions(context),
    });
    return result.status === FlowTypesStatus.NoFlow ? undefined : result;
  } catch (error) {
    // a missing module is reported by the old path as workflow.load, with its own message
    if (error instanceof WorkflowLoadError) return undefined;
    throw error;
  }
}

const problemsOf = (file: string, result: FlowTypesResult): readonly CheckProblem[] =>
  result.errors.map((found) => ({ file, code: found.code, message: found.message }));

/** What writing the types gave `agboss check`: its warnings and notes, and the file if written. */
export interface TypesOutcome {
  /** Generation's own problems (`[types.unexported-class]`, a name clash): the file was not written. */
  readonly problems: readonly CheckProblem[];
  readonly warnings: readonly string[];
  /** The written file, relative to the project; undefined when not written. */
  readonly types?: string;
}

/**
 * `agboss check` first writes `.agboss/types.d.ts` (#272 S7): the analyser's warnings (`[flow.path-too-deep]`)
 * and notes are reported here, generation's own problems returned; a rule violation is reported by
 * the assembly that follows (once).
 */
export async function writeCheckedTypes(
  context: CommandContext,
  file: string,
): Promise<TypesOutcome> {
  const result = await generate(context, file);
  if (result === undefined) return { problems: [], warnings: [] };
  // a rule violation is the assembly's to report; generation's own codes are `types.*`
  const problems = problemsOf(file, result).filter((found) => found.code.startsWith("types."));
  const warnings = [
    ...result.warnings.map((found) => problemText({ file, ...found })),
    ...result.notes,
  ];
  warnings.forEach((line) => {
    context.say(line);
  });
  if (result.status !== FlowTypesStatus.Written) return { problems, warnings };
  const types = relative(context.io.cwd, result.outFile);
  context.say(`types: ${types}`);
  return { problems, warnings, types };
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
    context.warn(
      `types not regenerated: ${reason ?? ""} — run agboss check --workflow ${workflow}`,
    );
    return undefined;
  });
  if (result === undefined) return;
  if (result.status === FlowTypesStatus.Written)
    context.say(`  types: ${relative(context.io.cwd, result.outFile)}`);
  else
    problemsOf(workflow, result).forEach((problem) => {
      context.warn(problemText(problem));
    });
}
