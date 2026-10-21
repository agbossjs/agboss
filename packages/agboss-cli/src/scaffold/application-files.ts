import type { Names } from "./names.js";
import { render, vars } from "./plan.js";
import type { FileToWrite } from "./write.js";

/** Where `agboss create` puts the application of a project: `src/<project>.application.ts`. */
export const applicationPathOf = (project: Names): string => `src/${project.kebab}.application.ts`;

/**
 * The application of a new project and what it lists (#261, #268 AC8): its budgets, its model
 * provider, its guardrail — every workflow's — and its first workflow, `src/<project>/`.
 */
export const applicationFiles = (project: Names): FileToWrite[] => [
  {
    path: applicationPathOf(project),
    content: render("workflow/application.ts.tmpl", vars(project)),
  },
  { path: "src/config/budget.config.ts", content: render("workflow/budget.config.ts.tmpl", {}) },
  {
    path: "src/guardrails/prompt-injection.guardrail.ts",
    content: render("workflow/prompt-injection.guardrail.ts.tmpl", {}),
  },
  {
    path: "src/model-providers/openrouter.model-provider.ts",
    content: render("workflow/openrouter.model-provider.ts.tmpl", {}),
  },
];
