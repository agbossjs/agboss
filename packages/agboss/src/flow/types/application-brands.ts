import { applicationDeclarationOf } from "../../application/application.js";
import type { Class } from "../../components/injection.js";
import type { ImportTable } from "./imports.js";

/**
 * Each exported `@Application` class of the typed project — one that lists a typed workflow, or none
 * (tool-only) — is branded with whether it declares a `tenantContext` (#1324e).
 */
export function brandApplications(
  applications: readonly Class[],
  typed: readonly Class[],
  names: ImportTable,
): void {
  const workflows = new Set(typed);
  for (const application of applications) {
    const options = applicationDeclarationOf(application)?.options;
    if (options === undefined) continue;
    const listed = options.workflows;
    if (listed.length > 0 && !listed.some((workflow) => workflows.has(workflow))) continue;
    names.refApplication(application, options.tenantContext !== undefined);
  }
}
