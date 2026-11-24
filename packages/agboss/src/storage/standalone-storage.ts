import { applicationDeclarationOf, applicationsListing } from "../application/application.js";
import type { WorkflowMeta } from "../components/meta-types.js";
import { EnvironmentError } from "../environments/errors.js";
import { settingsEntriesOf } from "./settings.js";
import { resolvedStorageOfOptions } from "./storage-fields.js";

/**
 * The storage settings of a container that is no application's (`agboss check`, a workflow on its
 * own): the drivers' settings of the one loaded application that lists the workflow, read from the
 * process's variables, so a store or a repository on `SqliteConnection` is created as at start. A
 * variable that is not set leaves them out: the connection then names what it needs.
 */
export function standaloneStorageEntriesOf(
  bundle: WorkflowMeta,
): ReturnType<typeof settingsEntriesOf> {
  const workflow = bundle.type;
  const [only, ...others] = workflow === undefined ? [] : applicationsListing(workflow);
  const storage =
    only === undefined || others.length > 0
      ? undefined
      : applicationDeclarationOf(only)?.written.storage;
  try {
    return settingsEntriesOf(resolvedStorageOfOptions(storage, process.env));
  } catch (error) {
    if (error instanceof EnvironmentError) return [];
    throw error;
  }
}
