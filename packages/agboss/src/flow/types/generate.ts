import { dirname, relative } from "node:path";
import type { Class } from "../../components/injection.js";
import { violation, type RuleViolation } from "../../graph/rule-error.js";
import { checkWorkflow } from "../analyse/analyse.js";
import type { LoadedModule } from "../analyse/rules/context.js";
import {
  applicationDeclarationOf,
  type ApplicationOptions,
} from "../../application/application.js";
import { declaredFieldsOf } from "../../environments/contract.js";
import { declarationOf } from "../decorators/declaration.js";
import { ComponentRegistry, DtoRegistry, dtoClashMessage } from "../registry.js";
import { ImportTable } from "./imports.js";
import { ClassLocator } from "./locate.js";
import { printTypes } from "./print.js";
import { tablesOf, type AnalysedWorkflow } from "./tables.js";

/**
 * Type generation (#272 PR 3, S2): a pure function of the loaded application — its v2 workflows and
 * the project modules they were loaded from. Each workflow goes through the same analyser as
 * assembly; its rule violations are reported, and a node whose input breaks a data rule gets the
 * rule's message as its type. Generation itself fails — no file — when a class the types need is not
 * exported (`[types.unexported-class]`) or two classes share a name (`name` and DTO class names
 * key the tables).
 */

/** Where `.agboss/types.d.ts` lives in a project. */
export const GENERATED_TYPES_FILE = ".agboss/types.d.ts";

export interface FlowTypesRequest {
  readonly workflows: readonly Class[];
  /**
   * The project's `@Application` classes (#261): a workflow is checked with its application's
   * `defaults`, and each environment contract types `Environment`.
   */
  readonly applications?: readonly Class[];
  readonly modules: readonly LoadedModule[];
  /** The absolute path of the file, `<project>/.agboss/types.d.ts`. */
  readonly outFile: string;
  /** The module the tables are augmented in: `agboss`, or a file's absolute path (this repo). */
  readonly tablesModule?: string;
  /** `--strict`: analyser warnings are errors. */
  readonly strict?: boolean;
}

export interface FlowTypes {
  /** The file's text; undefined when generation failed. */
  readonly text?: string;
  readonly errors: readonly RuleViolation[];
  readonly warnings: readonly RuleViolation[];
  /** S4 lines: the nodes whose `InputOf` is flat. */
  readonly notes: readonly string[];
}

/** The project directory: the parent of `.agboss/`. */
const projectOf = (outFile: string): string => dirname(dirname(outFile));

function unexportedClass(component: Class, project: string): RuleViolation {
  const source = declarationOf(component)?.source;
  const where = source === undefined ? "" : ` (${relative(project, source)})`;
  return violation(
    "types.unexported-class",
    `${component.name}${where} is not exported — export it`,
    [],
  );
}

/** Two classes under one component name, or two DTO classes of one name, across the workflows. */
function nameClashes(workflows: readonly AnalysedWorkflow[], names: ImportTable): RuleViolation[] {
  const components = new ComponentRegistry();
  const dtos = new DtoRegistry();
  const found: RuleViolation[] = [];
  for (const { analysis } of workflows)
    for (const node of analysis.graph.nodes.values()) {
      const clash = components.register(node.component);
      if (clash === undefined) continue;
      const message =
        `${clash.registered.component.name} and ${clash.clashing.component.name} are both named ` +
        `"${clash.name}" — a name is unique in the application (it keys records and the generated types); rename one`;
      found.push(violation("graph.duplicate-node-name", message, [clash.name]));
    }
  for (const imported of names.dtos) {
    const clash = dtos.register(imported.dto, relative(projectOf(names.outFile), imported.file));
    if (clash !== undefined)
      found.push(violation("dto.duplicate-name", dtoClashMessage(clash), []));
  }
  return found;
}

/** An application's contract; none for an untyped caller that left `environment` out. */
const contractOf = (options: ApplicationOptions): Class[] => {
  // `environment` is required by the type; untyped (JS) callers may still leave it out
  const contract = (options as Partial<ApplicationOptions>).environment;
  return contract === undefined ? [] : [contract];
};

export function generateFlowTypes(request: FlowTypesRequest): FlowTypes {
  const options = {
    modules: request.modules,
    ...(request.strict === undefined ? {} : { strict: request.strict }),
  };
  const applications = (request.applications ?? []).flatMap((application) => {
    const declaration = applicationDeclarationOf(application);
    return declaration === undefined ? [] : [declaration.options];
  });
  const checks = request.workflows.map((workflow) => {
    const listing = applications.filter((app) => app.workflows.includes(workflow));
    const [only] = listing;
    const defaults = listing.length === 1 ? only?.defaults : undefined;
    return checkWorkflow(
      workflow,
      defaults === undefined ? options : { ...options, applicationDefaults: defaults },
    );
  });
  const errors = checks.flatMap((check) => check.errors);
  const warnings = checks.flatMap((check) => check.warnings);
  const workflows = checks.flatMap((check): AnalysedWorkflow[] =>
    check.analysis === undefined ? [] : [{ analysis: check.analysis, errors: check.errors }],
  );
  const names = new ImportTable(new ClassLocator(request.modules), request.outFile);
  const tables = tablesOf(workflows, names);
  // each exported workflow class is branded too, so `createApp(W)` / `testWith(W)` do not compile
  request.workflows.forEach((workflow, index) => {
    if (checks[index]?.analysis !== undefined) names.refIfExported(workflow);
  });
  const contracts = [...new Set(applications.flatMap(contractOf))]
    // an empty contract (an application with no settings) adds nothing to `Environment`
    .filter((contract) => declaredFieldsOf(contract).length > 0)
    .map((contract) => names.refPlain(contract));
  const tablesModule = names.specifier(request.tablesModule ?? "agboss");
  const text = printTypes({ ...tables, environments: contracts }, names, tablesModule);
  const failures = [
    ...names.unexported.map((component) => unexportedClass(component, projectOf(request.outFile))),
    ...nameClashes(workflows, names),
  ];
  const all = [...errors, ...failures];
  const result = { errors: all, warnings, notes: tables.notes };
  return failures.length === 0 ? { ...result, text } : result;
}
