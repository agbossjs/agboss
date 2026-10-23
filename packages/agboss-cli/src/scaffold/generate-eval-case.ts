import { dirname, join, normalize } from "node:path/posix";
import type { EvalCaseDraft } from "agboss/internal";
import ts from "typescript";
import { closestName } from "../cli/did-you-mean.js";
import { applicationModuleOf } from "./application-graph.js";
import { declarationsIn } from "./declarations.js";
import { ScaffoldUsageError } from "./errors.js";
import { withEvalCase } from "./eval-case-source.js";
import { read } from "./project-files.js";
import type { Component } from "./workflow-graph.js";
import type { Changes, FileToWrite } from "./write.js";

/**
 * `agboss generate eval-case <name> --suite <name> --from-execution <executionId>` (#396 PR 8): the
 * drafted case written into its suite — the suite found among the application's `@EvalSuite`
 * classes by its full name (optional when it has one), its start the execution's (else
 * `eval.case-start-mismatch`, the two named).
 */

/** Where the case goes: the application (`--application`, else package.json) and `--suite`. */
export interface EvalCaseTarget {
  readonly application?: string | undefined;
  readonly suite?: string | undefined;
}

/** The plan, and what of the draft no class was found for. */
export interface EvalCasePlan {
  readonly changes: Changes;
  readonly skipped: readonly string[];
}

/** The folders of the modules a file imports by a relative path. */
function importedFolders(root: string, path: string): string[] {
  const { content } = read(root, path);
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  return source.statements.filter(ts.isImportDeclaration).flatMap((declaration) => {
    const specifier = declaration.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) return [];
    return [normalize(join(dirname(path), dirname(specifier.text)))];
  });
}

/**
 * The project's classes: under the application's folder, and under the folders of what the
 * application imports (a workflow kept beside it), each folder read once.
 */
function projectDeclarations(root: string, application: string): readonly Component[] {
  const folders = [dirname(application), ...importedFolders(root, application)];
  const inside = (folder: string, other: string): boolean =>
    folder !== other && (folder + "/").startsWith(other === "." ? "" : `${other}/`);
  const outermost = [...new Set(folders)].filter(
    (folder, _, all) => !all.some((other) => inside(folder, other)),
  );
  const found = outermost.flatMap((folder) => declarationsIn(root, folder));
  return [
    ...new Map(
      found.map((declaration) => [`${declaration.path}#${declaration.className}`, declaration]),
    ).values(),
  ];
}

/** The suite `--suite` names among the application's — the only one when it has one. */
function suiteOf(suites: readonly Component[], given: string | undefined): Component {
  const names = suites.flatMap((suite) => (suite.id === undefined ? [] : [suite.id]));
  const [only] = suites;
  if (given === undefined && only !== undefined && suites.length === 1) return only;
  const found = suites.find((suite) => suite.id === given);
  if (found !== undefined) return found;
  const closest = given === undefined ? undefined : closestName(given, names);
  const hint = closest === undefined ? "" : ` Did you mean "${closest}"?`;
  const what =
    given === undefined
      ? `the application has ${String(suites.length)} eval suites: name one with --suite`
      : `no eval suite named "${given}"`;
  throw new ScaffoldUsageError(`${what}.${hint} Its suites: ${names.join(", ") || "none"}`);
}

/** The class name of the suite's `start: X`. */
function startClassOf(suite: Component, content: string): string | undefined {
  const source = ts.createSourceFile(suite.path, content, ts.ScriptTarget.Latest, true);
  const declaration = source.statements
    .filter(ts.isClassDeclaration)
    .find((found) => found.name?.text === suite.className);
  const call = (declaration === undefined ? [] : (ts.getDecorators(declaration) ?? []))
    .map((decorator) => decorator.expression)
    .find(ts.isCallExpression);
  const [options] = call?.arguments ?? [];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return undefined;
  const start = options.properties
    .filter(ts.isPropertyAssignment)
    .find((p) => ts.isIdentifier(p.name) && p.name.text === "start");
  return start !== undefined && ts.isIdentifier(start.initializer)
    ? start.initializer.text
    : undefined;
}

/** The suite's start must be the execution's: a case runs through the suite's start. */
function checkStart(
  declarations: readonly Component[],
  suite: Component,
  content: string,
  draft: EvalCaseDraft,
): void {
  const className = startClassOf(suite, content);
  const start = declarations.find((found) => found.className === className)?.id;
  if (start === undefined || start === draft.start) return;
  throw new ScaffoldUsageError(
    `[eval.case-start-mismatch] ${suite.id ?? suite.className} runs ${start}; the execution started at ${draft.start}`,
  );
}

/** A suite's source file, with the project's classes its cases may name. */
export interface EvalSuiteSource {
  readonly suite: Component;
  readonly file: FileToWrite;
  readonly declarations: readonly Component[];
}

/** The file of the suite `target` names, as it is now (#397 PR 5 hashes it for its ETag). */
export function evalSuiteSourceOf(root: string, target: EvalCaseTarget): EvalSuiteSource {
  const application = applicationModuleOf(root, target.application);
  const declarations = projectDeclarations(root, application);
  // the application's suites: under its own folder (its eval-suites/), never an imported folder's
  const own = `${dirname(application)}/`;
  const suites = declarations.filter(
    (found) => found.decorator === "EvalSuite" && found.path.startsWith(own),
  );
  const suite = suiteOf(suites, target.suite);
  return { suite, file: read(root, suite.path), declarations };
}

/** The suite's file with the case added. */
export function planEvalCase(
  root: string,
  draft: EvalCaseDraft,
  target: EvalCaseTarget,
): EvalCasePlan {
  if (draft.name.trim() === "") throw new ScaffoldUsageError("the case needs a name");
  const { suite, file, declarations } = evalSuiteSourceOf(root, target);
  checkStart(declarations, suite, file.content, draft);
  const written = withEvalCase(file, suite.id ?? "", draft, { declarations });
  return { changes: { create: [], modify: [written.file] }, skipped: written.skipped };
}
