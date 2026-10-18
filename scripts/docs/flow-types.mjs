// The generated types of a doc's workflows (#272): a doc whose snippets declare a `@Workflow` (or an
// `@Application`, #261 — its defaults and environment contract) is a project like any other — its `.agboss/types.d.ts` is written (as `agboss check` writes it) before
// the snippets are typechecked, so a path written in the typed grammar compiles as in a project.
import { join } from "node:path";
import { readFileSync } from "node:fs";

const DECLARES_WORKFLOW = /@Workflow\(/;
const DECLARES_APPLICATION = /@Application\(/;
// a snippet that runs something when loaded (a test, a top-level createApp) is not a module to load
const RUNS_WHEN_LOADED = /from "(vitest|agboss\/testing)"|createApp\(/;

/** A snippet the generator loads: a workflow, or an application that only declares. */
const isFlowModule = (text) =>
  DECLARES_WORKFLOW.test(text) || (DECLARES_APPLICATION.test(text) && !RUNS_WHEN_LOADED.test(text));

/**
 * Writes `<folder>/.agboss/types.d.ts` for the doc's workflow snippets; returns the file (to compile
 * with the snippets) and the problems — a module that does not load, a class that is not exported.
 */
export async function writeDocTypes(folder, doc, files) {
  const workflows = files
    .map((file) => file.path)
    .filter((path) => isFlowModule(readFileSync(path, "utf8")));
  if (workflows.length === 0) return { types: [], problems: [] };
  const { FlowTypesStatus, writeFlowTypes } = await import("agboss/internal");
  try {
    const result = await writeFlowTypes({ files: workflows, project: folder });
    const problems = result.errors.map((found) => `${doc}: [${found.code}] ${found.message}`);
    const written = result.status === FlowTypesStatus.Written;
    return { types: written ? [join(folder, ".agboss/types.d.ts")] : [], problems };
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { types: [], problems: [`${doc}: its workflow snippets do not load — ${reason}`] };
  }
}
