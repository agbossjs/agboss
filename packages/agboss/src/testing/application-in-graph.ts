import { applicationsListing } from "../application/application.js";
import type { Class } from "../components/injection.js";
import { nameOf } from "../components/name-of.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { applicationsNear, lookalikeApplicationsNear } from "../loader/application-files.js";
import { TestSetupError } from "./errors.js";

/**
 * `workflowOf(W)` finds the application of `W` next to its file (#497). Installed from npm without
 * the vitest preset, `@agboss/core` is external to vitest, so that file is loaded by Node, outside
 * the test's module graph: Node cannot run its decorators, or (through tsx) it builds classes of a
 * second graph, whose application lists another `W`. Both are a test set up wrong, said so here
 * instead of an obscure syntax error or a workflow silently assembled without its application.
 */

const outsideGraph = (workflow: Class, cause?: unknown): TestSetupError =>
  new TestSetupError(
    `the application of ${nameOf(workflow)} was loaded outside vitest's module graph; use agbossTest() from @agboss/core/testing/vitest in vitest.config.ts`,
    cause === undefined ? undefined : { cause },
  );

/**
 * Loads the application of `workflow` from the files near it, as the CLI does, unless one listing
 * it is loaded already; throws `TestSetupError` when those files come from outside the test's
 * module graph: their import fails (the original error as `cause`), or the only application found
 * lists a class named like `workflow` but not `workflow` itself.
 */
export async function loadApplicationInGraph(workflow: Class): Promise<void> {
  const source = declarationOf(workflow)?.source;
  if (source === undefined || applicationsListing(workflow).length > 0) return;
  let found: ReadonlySet<Class>;
  try {
    found = await applicationsNear(source, workflow);
  } catch (error) {
    throw outsideGraph(workflow, error);
  }
  if (found.size === 0 && (await lookalikeApplicationsNear(source, workflow)).size > 0)
    throw outsideGraph(workflow);
}
