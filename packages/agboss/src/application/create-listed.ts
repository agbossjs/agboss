import type { BuiltApp } from "../app/create-app.js";
import { isClassProvider } from "../components/injection.js";
import { moduleOf } from "../components/module.js";
import type { AssembledApplication } from "./assemble.js";

/**
 * Every class the application and its workflows list (providers, budgets), created now — one
 * instance each, so a missing dependency fails at start and every one gets its hooks.
 */
export function createListed(
  assembled: AssembledApplication,
  workflows: readonly BuiltApp[],
): void {
  const [first] = workflows;
  if (first === undefined) return;
  for (const module of assembled.modules) {
    for (const provider of module.providers) {
      if (typeof provider === "function") first.app.resolve(provider);
      // a class for a token (#891): created now too, under its token, its hooks with the rest
      else if (isClassProvider(provider)) first.app.resolve(provider.useClass);
    }
  }
  // a workflow's own services (#1324) are created in its container, each workflow's alone
  for (const workflow of workflows) {
    for (const service of moduleOf(workflow.bundle.graph.type).services ?? []) {
      if (typeof service === "function") workflow.app.resolve(service);
    }
  }
}
