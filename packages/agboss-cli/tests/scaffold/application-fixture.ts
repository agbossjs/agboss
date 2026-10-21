/**
 * A project's application for the generators' tests (#268 AC8): `package.json` naming it
 * (`"agboss": { "application" }`) and an `@Application` listing one workflow, which the generators
 * find by its full name.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** The workflow the application lists: its module, its class and its full name. */
export interface ListedWorkflow {
  readonly module: string;
  readonly className: string;
  readonly name: string;
}

/** The `@Workflow` declaration a workflow module needs to be found by its name. */
export const workflowDeclaration = ({ className, name }: ListedWorkflow): string =>
  `\n@Workflow({ name: "${name}", version: "1.0.0", flow: [] })\nexport class ${className} {}\n`;

/** Writes `src/desk.application.ts` listing `workflow`, and package.json pointing at it. */
export function writeApplication(root: string, workflow: ListedWorkflow): string {
  const path = "src/desk.application.ts";
  const from = relative(dirname(join(root, path)), join(root, workflow.module)).replace(
    /\.ts$/,
    ".js",
  );
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, path),
    [
      'import { Application, EmptyEnvironment } from "agboss";',
      `import { ${workflow.className} } from "./${from}";`,
      "",
      "@Application({",
      '  name: "desk-application",',
      '  version: "1.0.0",',
      "  environment: EmptyEnvironment,",
      `  workflows: [${workflow.className}],`,
      "})",
      "export class DeskApplication {}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "desk", agboss: { application: path } }, null, 2)}\n`,
  );
  return path;
}
