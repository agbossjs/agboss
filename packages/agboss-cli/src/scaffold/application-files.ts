import type { Names } from "./names.js";
import { render, vars } from "./plan.js";
import type { FileToWrite } from "./write.js";

/**
 * The workflow's application and its budgets (#261) — until #268 wires `generate workflow` into
 * one application, each workflow folder has its own. `environment` is required: `withEnvironment`
 * = `agboss create` writes the contract and its environments, else `EmptyEnvironment` (no settings).
 */
export const applicationFiles = (
  dir: string,
  workflow: Names,
  withEnvironment = false,
): FileToWrite[] => [
  {
    path: `${dir}/${workflow.kebab}.application.ts`,
    content: render("workflow/application.ts.tmpl", {
      ...vars(workflow),
      // `agboss create` writes the contract and its environments next to the application (#261)
      environmentImport: withEnvironment
        ? 'import { AppEnvironment } from "./environments/app.environment.js";\n'
        : "",
      agbossImports: withEnvironment ? "Application" : "Application, EmptyEnvironment",
      environment: withEnvironment ? "AppEnvironment" : "EmptyEnvironment",
    }),
  },
  { path: `${dir}/config/budget.config.ts`, content: render("workflow/budget.config.ts.tmpl", {}) },
];
