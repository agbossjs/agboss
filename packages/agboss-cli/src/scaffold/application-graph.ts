import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path/posix";
import ts from "typescript";
import { closestName } from "../cli/did-you-mean.js";
import { ScaffoldError, ScaffoldUsageError } from "./errors.js";
import { read } from "./project-files.js";
import type { FileToWrite } from "./write.js";

/**
 * The application a generator works on (#268 AC8), read from its source — never run: its module
 * (`"agboss": { "application" }` of the project's package.json, or `--application <path>`) and the
 * workflows it lists, their children included, each by its full `name`.
 */

/** A workflow of the application: its `name`, its class and its module (relative to the root). */
export interface WorkflowEntry {
  readonly name: string;
  readonly className: string;
  readonly path: string;
}

/** The application module, its `@Application` class and its workflows. */
export interface ApplicationGraph {
  readonly module: FileToWrite;
  readonly className: string;
  readonly workflows: readonly WorkflowEntry[];
}

const SET_IT_HERE =
  'set "agboss": { "application": "src/<name>.application.ts" } in package.json, or pass --application <path>';

const parse = (path: string, content: string): ts.SourceFile =>
  ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);

/** `--application`, else the project's package.json; neither → where to set it. */
export function applicationModuleOf(root: string, given: string | undefined): string {
  if (given !== undefined) return given.replace(/^\.\//, "");
  const file = join(root, "package.json");
  const value = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as { agboss?: { application?: unknown } }).agboss
        ?.application
    : undefined;
  if (typeof value !== "string" || value === "")
    throw new ScaffoldError(`No application: ${SET_IT_HERE}`);
  return value.replace(/^\.\//, "");
}

/** The options of a class's `@<decorator>({ … })`, when the class has one. */
function decoratorOptions(
  source: ts.SourceFile,
  className: string,
  decorator: string,
): ts.ObjectLiteralExpression | undefined {
  const declaration = source.statements
    .filter(ts.isClassDeclaration)
    .find((c) => c.name?.text === className);
  const call = (declaration === undefined ? [] : (ts.getDecorators(declaration) ?? []))
    .map((d) => d.expression)
    .filter(ts.isCallExpression)
    .find((c) => ts.isIdentifier(c.expression) && c.expression.text === decorator);
  const [options] = call?.arguments ?? [];
  return options !== undefined && ts.isObjectLiteralExpression(options) ? options : undefined;
}

const propertyOf = (
  options: ts.ObjectLiteralExpression | undefined,
  key: string,
): ts.Expression | undefined =>
  options?.properties
    .filter(ts.isPropertyAssignment)
    .find((p) => ts.isIdentifier(p.name) && p.name.text === key)?.initializer;

/** Class name → the module it is imported from (relative imports only, resolved to `.ts`). */
function importsOf(path: string, source: ts.SourceFile): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const declaration of source.statements.filter(ts.isImportDeclaration)) {
    const specifier = ts.isStringLiteral(declaration.moduleSpecifier)
      ? declaration.moduleSpecifier.text
      : "";
    const named = declaration.importClause?.namedBindings;
    if (!specifier.startsWith(".") || named === undefined || !ts.isNamedImports(named)) continue;
    const module = join(dirname(path), specifier).replace(/\.js$/, ".ts");
    named.elements.forEach((element) => found.set(element.name.text, module));
  }
  return found;
}

/** The `@Workflow` classes a module imports — every class it imports that is one. */
function workflowsImportedBy(root: string, path: string): WorkflowEntry[] {
  const source = parse(path, read(root, path).content);
  return [...importsOf(path, source)].flatMap(([className, module]) => {
    if (!existsSync(join(root, module))) return [];
    const name = propertyOf(
      decoratorOptions(parse(module, read(root, module).content), className, "Workflow"),
      "name",
    );
    return name !== undefined && ts.isStringLiteralLike(name)
      ? [{ name: name.text, className, path: module }]
      : [];
  });
}

/** The class of the module decorated with `@Application`. */
function applicationClassOf(module: FileToWrite): string {
  const source = parse(module.path, module.content);
  const found = source.statements
    .filter(ts.isClassDeclaration)
    .flatMap((c) => (c.name === undefined ? [] : [c.name.text]))
    .find((name) => decoratorOptions(source, name, "Application") !== undefined);
  if (found === undefined) throw new ScaffoldError(`${module.path}: no @Application({ … }) class`);
  return found;
}

/** The application module and every workflow it reaches: those it lists and their children. */
export function applicationGraph(root: string, given: string | undefined): ApplicationGraph {
  const path = applicationModuleOf(root, given);
  const module = read(root, path);
  const className = applicationClassOf(module);
  const workflows: WorkflowEntry[] = [];
  const queue = workflowsImportedBy(root, path);
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (workflows.some((known) => known.path === next.path && known.className === next.className))
      continue;
    workflows.push(next);
    queue.push(...workflowsImportedBy(root, next.path));
  }
  return { module, className, workflows };
}

/** The workflow `--workflow <full name>` names (or the only one); unknown → a hint and the list, nothing written. */
export function workflowNamed(
  application: ApplicationGraph,
  name: string | undefined,
): WorkflowEntry {
  const known = application.workflows.map((workflow) => workflow.name);
  if (name === undefined || name === "") {
    if (application.workflows.length === 1 && application.workflows[0] !== undefined)
      return application.workflows[0];
    throw new ScaffoldUsageError(
      `--workflow <full name> is required — one of: ${known.join(", ") || "(none)"}`,
    );
  }
  const found = application.workflows.find((workflow) => workflow.name === name);
  if (found !== undefined) return found;
  const closest = closestName(name, known);
  const hint = closest === undefined ? "" : ` Did you mean "${closest}"?`;
  throw new ScaffoldUsageError(
    `Workflow "${name}" not found in ${application.module.path}.${hint} Workflows: ${known.join(", ") || "(none)"}`,
  );
}
