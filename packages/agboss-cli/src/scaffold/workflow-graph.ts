import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path/posix";
import ts from "typescript";
import { closestName } from "../cli/did-you-mean.js";
import { ScaffoldError, ScaffoldUsageError } from "./errors.js";
import { applicationGraph, workflowNamed } from "./application-graph.js";
import { read } from "./project-files.js";
import { flowCalls, type FlowCall } from "./wire-flow.js";
import type { FileToWrite } from "./write.js";

/** A class the workflow module imports: its decorator, its `name`, the file it lives in. */
export interface Component {
  readonly className: string;
  /** relative to the project root */
  readonly path: string;
  /** `Agent`, `Router`, `WorkflowFinish`, … — undefined when the class has none */
  readonly decorator: string | undefined;
  /** the decorator's `name: "…"` */
  readonly id: string | undefined;
}

/**
 * The workflow as its module declares it (#197): the classes it imports, resolved to their files and
 * decorators, and its flow — what the generators wire into, whatever the project's layout.
 */
export interface WorkflowGraph {
  readonly module: FileToWrite;
  readonly dir: string;
  readonly components: readonly Component[];
  readonly flow: readonly FlowCall[];
  readonly source: ts.SourceFile;
}

const parse = (file: FileToWrite): ts.SourceFile =>
  ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);

/** `./agents/x.agent.js` imported from `src/x.workflow.ts` → `src/agents/x.agent.ts`. */
const resolveModule = (from: string, specifier: string): string =>
  join(dirname(from), specifier).replace(/\.js$/, ".ts");

const textOf = (node: ts.Expression | undefined): string | undefined =>
  node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;

/** The decorator of an exported class and its `name` option. */
function decoratorOf(
  source: ts.SourceFile,
  className: string,
): Pick<Component, "decorator" | "id"> {
  const none = { decorator: undefined, id: undefined };
  const declaration = source.statements
    .filter(ts.isClassDeclaration)
    .find((c) => c.name?.text === className);
  if (declaration === undefined) return none;
  const call = (ts.getDecorators(declaration) ?? [])
    .map((d) => d.expression)
    .find(ts.isCallExpression);
  if (call === undefined || !ts.isIdentifier(call.expression)) return none;
  const [options] = call.arguments;
  const name =
    options !== undefined && ts.isObjectLiteralExpression(options)
      ? options.properties
          .filter(ts.isPropertyAssignment)
          .find((p) => ts.isIdentifier(p.name) && p.name.text === "name")
      : undefined;
  return { decorator: call.expression.text, id: textOf(name?.initializer) };
}

function readSource(root: string, path: string): ts.SourceFile | undefined {
  try {
    return parse({ path, content: readFileSync(join(root, path), "utf8") });
  } catch {
    return undefined;
  }
}

/** Every class the module imports from a relative path, with its file and decorator. */
function componentsOf(root: string, module: FileToWrite, source: ts.SourceFile): Component[] {
  return source.statements.filter(ts.isImportDeclaration).flatMap((declaration) => {
    const specifier = textOf(declaration.moduleSpecifier) ?? "";
    const named = declaration.importClause?.namedBindings;
    if (!specifier.startsWith(".") || named === undefined || !ts.isNamedImports(named)) return [];
    const path = resolveModule(module.path, specifier);
    const file = readSource(root, path);
    return named.elements.map((element) => ({
      className: element.name.text,
      path,
      ...(file === undefined
        ? { decorator: undefined, id: undefined }
        : decoratorOf(file, (element.propertyName ?? element.name).text)),
    }));
  });
}

/**
 * The module's classes plus what its routers import: an agent or a finish only a router's routes
 * name is found through the router's file (#200).
 */
function withRouterTargets(root: string, own: readonly Component[]): Component[] {
  const found = [...own];
  for (const router of own.filter((c) => c.decorator === "Router")) {
    const source = readSource(root, router.path);
    if (source === undefined) continue;
    const content = source.getFullText();
    for (const target of componentsOf(root, { path: router.path, content }, source)) {
      if (!found.some((c) => c.className === target.className)) found.push(target);
    }
  }
  return found;
}

/** Where a generator looks for the workflow: `--workflow <full name>` in the application. */
export interface WorkflowTarget {
  readonly workflow?: string | undefined;
  readonly application?: string | undefined;
}

/** `--workflow <full name>` found in the application, its module read and resolved. */
export function workflowGraph(root: string, target: WorkflowTarget): WorkflowGraph {
  const { path } = workflowNamed(applicationGraph(root, target.application), target.workflow);
  const module = read(root, path);
  const dir = dirname(path);
  const source = parse(module);
  return {
    module,
    dir,
    source,
    components: withRouterTargets(root, componentsOf(root, module, source)),
    flow: flowCalls(source),
  };
}

export const ofKind = (graph: WorkflowGraph, decorator: string): readonly Component[] =>
  graph.components.filter((c) => c.decorator === decorator);

/** The folder the workflow keeps a kind in (where its first one lives), else `<workflow dir>/<sub>`. */
export const folderOf = (graph: WorkflowGraph, decorator: string, sub: string): string => {
  const [first] = ofKind(graph, decorator);
  return first === undefined ? `${graph.dir}/${sub}` : dirname(first.path);
};

/** The workflow finish new routers send the answer to. */
export function finishOf(graph: WorkflowGraph): Component {
  const [finish] = ofKind(graph, "WorkflowFinish");
  if (finish === undefined)
    throw new ScaffoldError(`${graph.module.path}: imports no @WorkflowFinish class`);
  return finish;
}

/** An agent of the workflow by its full name (`--agent billing-agent`); unknown → a hint and the list. */
export function agentOf(graph: WorkflowGraph, name: string): Component {
  const agents = ofKind(graph, "Agent");
  const agent = agents.find((c) => c.id === name);
  if (agent === undefined) {
    const known = agents.flatMap((c) => (c.id === undefined ? [] : [c.id]));
    const closest = closestName(name, known);
    const hint = closest === undefined ? "" : ` Did you mean "${closest}"?`;
    throw new ScaffoldUsageError(
      `Agent "${name}" not found in ${graph.module.path}.${hint} Agents: ${known.join(", ")}`,
    );
  }
  return agent;
}

/** `from` → `to` as an import specifier (`../tools/x.tool.js`). */
export function importPath(from: string, to: string): string {
  const path = relative(dirname(from), to).replace(/\.ts$/, ".js");
  return path.startsWith(".") ? path : `./${path}`;
}
