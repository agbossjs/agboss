import type { Names } from "./names.js";
import { render, vars } from "./plan.js";
import type { FileToWrite } from "./write.js";

/**
 * The workflow's application and its budgets (#261) — until #268 wires `generate workflow` into
 * one application, each workflow folder has its own.
 */
export const applicationFiles = (dir: string, workflow: Names): FileToWrite[] => [
  {
    path: `${dir}/${workflow.kebab}.application.ts`,
    content: render("workflow/application.ts.tmpl", vars(workflow)),
  },
  { path: `${dir}/config/budget.config.ts`, content: render("workflow/budget.config.ts.tmpl", {}) },
];
