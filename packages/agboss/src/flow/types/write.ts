import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuleViolation } from "../../graph/rule-error.js";
import { loadFlowProject } from "../../loader/load-flow.js";
import type { LoadedModule } from "../analyse/rules/context.js";
import { GENERATED_TYPES_FILE, generateFlowTypes } from "./generate.js";
import { lazyLoad } from "../../infrastructure/clock.js";

/**
 * `agboss check`, the end of `agboss generate` and the repo's `check:types` step (#272 S7): load the
 * workflow modules (tsx, transpile-only — S2), generate, write `<project>/.agboss/types.d.ts`. A
 * module without a v2 workflow is left alone (the old DSL until #272 PR 4).
 */

export enum FlowTypesStatus {
  /** The modules hold no v2 workflow: nothing generated. */
  NoFlow = "no-flow",
  /** The file was written. */
  Written = "written",
  /** Generation failed (`[types.unexported-class]`, a name clash): the file was not written. */
  Failed = "failed",
}

/** What to generate the types of, and where. */
export interface FlowTypesWrite {
  /** The workflow modules. */
  readonly files: readonly string[];
  /** The project directory; the file goes to `<project>/.agboss/types.d.ts`. */
  readonly project: string;
  /** false where TypeScript is already compiled (tests); tsx is registered by default. */
  readonly typescript?: boolean;
  /** The module the tables are augmented in: `@agboss/core` by default, a file's path in this repo. */
  readonly tablesModule?: string;
  /**
   * Where to write, relative to the project: a file directly in `.agboss/` (#468 — the types of an
   * application that is not the project's own, so the project's `.agboss/types.d.ts` is left alone).
   * Default: `.agboss/types.d.ts`.
   */
  readonly outFile?: string;
}

/** What generation did and found. */
export interface FlowTypesResult {
  /** Whether the file was written. */
  readonly status: FlowTypesStatus;
  /** `<project>/.agboss/types.d.ts`. */
  readonly outFile: string;
  /** The workflows' rule violations and generation's own (`[types.unexported-class]`, clashes). */
  readonly errors: readonly RuleViolation[];
  /** The analyser's warnings (`[flow.path-too-deep]`). */
  readonly warnings: readonly RuleViolation[];
  /** S4 lines: the nodes whose `InputOf` is flat. */
  readonly notes: readonly string[];
}

/** An entry of the package a project imports classes from, and how its module is loaded. */
export interface PackageEntry {
  readonly specifier: string;
  readonly load: () => Promise<Readonly<Record<string, unknown>>>;
}

/**
 * The package's own entries a project imports standard classes from (`WorkflowStartTextDto` from
 * `@agboss/core/dto`, #904: `WorkflowFinishFileDto` and `A2AFileDto` from `@agboss/core/a2a`) — every
 * entry that exports a DTO class (`tests/flow/types/package-entries.test.ts` holds it so): an
 * installed package is not a project module, so it is never in tsx's record.
 */
export const PACKAGE_ENTRIES: readonly PackageEntry[] = [
  { specifier: "@agboss/core/dto", load: () => lazyLoad(import("../../dto/index.js")) },
  { specifier: "@agboss/core/a2a", load: () => lazyLoad(import("../../a2a/index.js")) },
  { specifier: "@agboss/core", load: () => lazyLoad(import("../../index.js")) },
];

/** The package's entries as loaded modules, in the order a class is looked for. */
export const packageModules = async (): Promise<readonly LoadedModule[]> =>
  Promise.all(
    PACKAGE_ENTRIES.map(async (entry) => ({ file: entry.specifier, exports: await entry.load() })),
  );

/** Loads the modules, generates the types and writes them (unless generation failed). */
export async function writeFlowTypes(request: FlowTypesWrite): Promise<FlowTypesResult> {
  const outFile = join(request.project, request.outFile ?? GENERATED_TYPES_FILE);
  const typescript = request.typescript === undefined ? {} : { typescript: request.typescript };
  const project = await loadFlowProject(request.files, typescript);
  const { workflows, applications } = project;
  // in this repo the tables are the framework's sources (`tablesModule`): no package to import from
  const modules =
    request.tablesModule === undefined
      ? [...project.modules, ...(await packageModules())]
      : project.modules;
  if (workflows.length === 0)
    return { status: FlowTypesStatus.NoFlow, outFile, errors: [], warnings: [], notes: [] };
  const generated = generateFlowTypes({
    workflows,
    applications,
    modules,
    outFile,
    ...(request.tablesModule === undefined ? {} : { tablesModule: request.tablesModule }),
  });
  const { errors, warnings, notes, text } = generated;
  if (text === undefined)
    return { status: FlowTypesStatus.Failed, outFile, errors, warnings, notes };
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, text);
  return { status: FlowTypesStatus.Written, outFile, errors, warnings, notes };
}
