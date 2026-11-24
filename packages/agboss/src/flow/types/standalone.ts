import type { Class } from "../../components/injection.js";
import { NodeKind } from "../ast.js";
import { TEXT_AGENT_INPUT } from "../analyse/fields.js";
import {
  declarationOf,
  type ComponentDeclaration,
  type InputFields,
} from "../decorators/declaration.js";
import { TablesImport, type ImportTable } from "./imports.js";
import {
  outputText,
  producedText,
  propertyName,
  startInputText,
  startOutputText,
  valueText,
} from "./shapes.js";
import { routeTargetsOf } from "./tables.js";
import { Wrapper } from "../dto-wrappers.js";

/**
 * The types of the decorated classes no workflow's graph reaches (#1324g): a component under test
 * (`testUnit(Action)`), a tool-only application's router. `.agboss/types.d.ts` types every decorated
 * class of the project's `src/`, so `InputOf<Self>` / `OutputOf<Self>` of a handler compiles before
 * any workflow names it. With no path there is no producer: each field is `Produced<Dto, never>`.
 * A class a workflow does reach keeps its path-sensitive entry from `tables.ts`.
 */

/** The entries one standalone class adds, per table (a plain map each, like `TypeTables`). */
export interface StandaloneTables {
  readonly producerOutputs: Map<string, string>;
  readonly inputs: Map<string, string>;
  readonly outputs: Map<string, string>;
  readonly routes: Map<string, string>;
  readonly routerAnswers: Map<string, string>;
}

/** `{ field: Produced<Dto, never>; … }`; `NoInput` for a class that reads nothing. */
function inputText(fields: InputFields, names: ImportTable): string {
  const entries = Object.entries(fields);
  if (entries.length === 0) return names.use(TablesImport.NoInput);
  const members = entries.map(([name, shape]) => {
    const isOptional = typeof shape !== "function" && shape.kind === Wrapper.Optional;
    const text = producedText(shape, "never", names);
    return isOptional
      ? `${propertyName(name)}?: ${text} | undefined`
      : `${propertyName(name)}: ${text}`;
  });
  return `{ ${members.join("; ")} }`;
}

/** What a router's `route()` returns with no launch in sight: one target, or a list of them. */
function routerAnswerOf(route: string): string {
  const element = route.includes(" | ") ? `(${route})` : route;
  return `${route} | readonly ${element}[]`;
}

function write(
  declaration: ComponentDeclaration,
  names: ImportTable,
  tables: StandaloneTables,
): void {
  const name = declaration.options.name;
  switch (declaration.kind) {
    case NodeKind.Start:
      tables.inputs.set(name, startInputText(declaration.options.input, names));
      tables.producerOutputs.set(name, startOutputText(declaration.options.input, names));
      return;
    case NodeKind.Finish:
      tables.outputs.set(name, valueText(declaration.options.output, names));
      return;
    case NodeKind.Agent:
      tables.inputs.set(name, inputText(declaration.options.input ?? TEXT_AGENT_INPUT, names));
      tables.producerOutputs.set(name, outputText(declaration.options.output, names));
      return;
    case NodeKind.Action:
    case NodeKind.Question:
      tables.inputs.set(name, inputText(declaration.options.input ?? {}, names));
      tables.producerOutputs.set(name, outputText(declaration.options.output, names));
      tables.outputs.set(name, outputText(declaration.options.output, names));
      return;
    case NodeKind.Router:
      writeRouter(declaration.options, names, tables);
      return;
    case NodeKind.Workflow:
      return;
  }
}

function writeRouter(
  options: Extract<ComponentDeclaration, { kind: NodeKind.Router }>["options"],
  names: ImportTable,
  tables: StandaloneTables,
): void {
  tables.inputs.set(options.name, inputText(options.input, names));
  const targets = routeTargetsOf(options).map((target) => `typeof ${names.ref(target)}`);
  const route = targets.length === 0 ? "never" : [...new Set(targets)].sort().join(" | ");
  tables.routes.set(options.name, route);
  tables.routerAnswers.set(options.name, routerAnswerOf(route));
}

/** Whether every class the class's entries name is exported (tried on a table of its own). */
function isTypable(
  component: Class,
  declaration: ComponentDeclaration,
  names: ImportTable,
): boolean {
  const probe = names.fork();
  probe.ref(component);
  write(declaration, probe, {
    producerOutputs: new Map(),
    inputs: new Map(),
    outputs: new Map(),
    routes: new Map(),
    routerAnswers: new Map(),
  });
  return probe.unexported.length === 0;
}

/**
 * The entries of the decorated `components` no analysed workflow reaches (`reached`), each class
 * recorded for its brand.
 */
export function standaloneTablesOf(
  components: readonly Class[],
  reached: ReadonlySet<Class>,
  names: ImportTable,
): StandaloneTables {
  const tables: StandaloneTables = {
    producerOutputs: new Map(),
    inputs: new Map(),
    outputs: new Map(),
    routes: new Map(),
    routerAnswers: new Map(),
  };
  // a name keys the tables: a class under a name a workflow's component (or an earlier class)
  // already has is left out, so it never overwrites the entry the path-sensitive types read
  const taken = new Set(
    [...reached].flatMap((component) => declarationOf(component)?.options.name ?? []),
  );
  for (const component of components) {
    if (reached.has(component)) continue;
    const declaration = declarationOf(component);
    if (declaration !== undefined) {
      if (taken.has(declaration.options.name)) continue;
      taken.add(declaration.options.name);
    }
    // a class that needs a type no module exports is left out, not a failure: nothing uses it yet
    if (declaration !== undefined && !isTypable(component, declaration, names)) continue;
    names.ref(component);
    if (declaration !== undefined) write(declaration, names, tables);
  }
  return tables;
}
