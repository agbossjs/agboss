import type { EvalCaseDraft } from "agboss/internal";
import ts from "typescript";
import { declarationNamed } from "./declarations.js";
import { ScaffoldConflictError, ScaffoldError } from "./errors.js";
import { importEdits } from "./eval-case-imports.js";
import type { Component } from "./workflow-graph.js";
import type { FileToWrite } from "./write.js";

/**
 * An eval case drafted from an execution (`EvalCaseDraft`, #396 PR 8), written into its suite's
 * file: one `evalCase({ … })` appended to `@EvalSuite({ cases })`, the builders it calls added to
 * the file's import of `agboss/eval`, and each class it names — the history's starts and finishes,
 * the required tools — imported from its own file. What `agboss generate eval-case --from-execution`
 * writes; a page that saves a run as a case (#397 PR 5) writes it the same way.
 */

/** What the case source refers to: the project's classes by component name. */
export interface CaseClasses {
  readonly declarations: readonly Component[];
}

/** The case written into a suite, and what of the draft was left out. */
export interface WrittenCase {
  readonly file: FileToWrite;
  /** Parts no class was found for (an MCP server's own tool, a knowledge base's search). */
  readonly skipped: readonly string[];
}

const START = ["WorkflowStart"];
const FINISH = ["WorkflowFinish"];
const TOOL = ["Tool", "McpTool"];

/** A value as TypeScript source: JSON is an object literal. */
const literal = (value: unknown): string => JSON.stringify(value ?? {});

/** The source of the case, and the classes and builders it uses. */
export interface CaseSource {
  readonly text: string;
  readonly classes: readonly Component[];
  readonly builders: readonly string[];
  readonly skipped: readonly string[];
}

/** `pastTurn(Start, input, Finish, output)` per turn whose classes are found. */
function historyOf(draft: EvalCaseDraft, classes: CaseClasses) {
  const used: Component[] = [];
  const skipped: string[] = [];
  const turns = draft.history.flatMap((turn) => {
    const start = declarationNamed(classes.declarations, turn.start, START);
    const finish = declarationNamed(classes.declarations, turn.finish, FINISH);
    if (start === undefined || finish === undefined) {
      skipped.push(`a past turn ${turn.start} → ${turn.finish}: no class found`);
      return [];
    }
    used.push(start, finish);
    const args = [start.className, literal(turn.input), finish.className, literal(turn.output)];
    return [`pastTurn(${args.join(", ")})`];
  });
  return { turns, used, skipped };
}

/** `toolCall(Tool, arguments)` per required call whose tool class is found. */
function requiredOf(draft: EvalCaseDraft, classes: CaseClasses) {
  const used: Component[] = [];
  const skipped: string[] = [];
  const calls = draft.required.flatMap((call) => {
    const tool = declarationNamed(classes.declarations, call.tool, TOOL);
    if (tool === undefined) {
      skipped.push(`a call of ${call.tool}: no @Tool class found`);
      return [];
    }
    used.push(tool);
    return [`toolCall(${tool.className}, ${literal(call.arguments)})`];
  });
  return { calls, used, skipped };
}

/** The `evalCase({ … })` of the draft. */
export function evalCaseSourceOf(draft: EvalCaseDraft, classes: CaseClasses): CaseSource {
  const history = historyOf(draft, classes);
  const required = requiredOf(draft, classes);
  const fields = [
    `name: ${JSON.stringify(draft.name)}`,
    ...(draft.tenant === undefined ? [] : [`tenant: ${literal(draft.tenant)}`]),
    ...(draft.execution === undefined ? [] : [`execution: ${literal(draft.execution)}`]),
    ...(history.turns.length === 0 ? [] : [`history: [${history.turns.join(", ")}]`]),
    `turns: [${draft.turns.map((turn) => `turn(${literal(turn.input)})`).join(", ")}]`,
    ...(required.calls.length === 0 ? [] : [`tools: { required: [${required.calls.join(", ")}] }`]),
  ];
  const builders = [
    "evalCase",
    "turn",
    ...(history.turns.length === 0 ? [] : ["pastTurn"]),
    ...(required.calls.length === 0 ? [] : ["toolCall"]),
  ];
  return {
    text: `evalCase({ ${fields.join(", ")} })`,
    classes: [...history.used, ...required.used],
    builders,
    skipped: [...history.skipped, ...required.skipped],
  };
}

const parse = (file: FileToWrite): ts.SourceFile =>
  ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);

/** A property of an object literal, by its key. */
export const propertyOf = (
  options: ts.ObjectLiteralExpression,
  key: string,
): ts.Expression | undefined =>
  options.properties
    .filter(ts.isPropertyAssignment)
    .find((p) => ts.isIdentifier(p.name) && p.name.text === key)?.initializer;

/** The options of an `@EvalSuite({ … })` decorator, when that is what it is. */
function suiteOptionsOf(decorator: ts.Decorator): ts.ObjectLiteralExpression | undefined {
  const call = decorator.expression;
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return undefined;
  const [options] = call.arguments;
  return call.expression.text === "EvalSuite" &&
    options !== undefined &&
    ts.isObjectLiteralExpression(options)
    ? options
    : undefined;
}

/** The `cases: [ … ]` of the `@EvalSuite` named `suite` in the file. */
export function casesOf(
  source: ts.SourceFile,
  suite: string,
): ts.ArrayLiteralExpression | undefined {
  const decorators = source.statements
    .filter(ts.isClassDeclaration)
    .flatMap((declaration) => ts.getDecorators(declaration) ?? []);
  for (const decorator of decorators) {
    const options = suiteOptionsOf(decorator);
    const name = options === undefined ? undefined : propertyOf(options, "name");
    const cases = options === undefined ? undefined : propertyOf(options, "cases");
    const isSuite = name !== undefined && ts.isStringLiteralLike(name) && name.text === suite;
    if (isSuite && cases !== undefined && ts.isArrayLiteralExpression(cases)) return cases;
  }
  return undefined;
}

/** The names of the cases the array already has (`evalCase({ name: "…" })`). */
const caseNamesOf = (cases: ts.ArrayLiteralExpression): readonly string[] =>
  cases.elements.flatMap((element) => {
    const [options] = ts.isCallExpression(element) ? element.arguments : [];
    if (options === undefined || !ts.isObjectLiteralExpression(options)) return [];
    const name = options.properties
      .filter(ts.isPropertyAssignment)
      .find((p) => ts.isIdentifier(p.name) && p.name.text === "name");
    return name !== undefined && ts.isStringLiteralLike(name.initializer)
      ? [name.initializer.text]
      : [];
  });

/** The suite's file with the drafted case appended to its cases (a case of that name → conflict). */
export function withEvalCase(
  file: FileToWrite,
  suite: string,
  draft: EvalCaseDraft,
  classes: CaseClasses,
): WrittenCase {
  const source = parse(file);
  const cases = casesOf(source, suite);
  if (cases === undefined)
    throw new ScaffoldError(`${file.path}: no @EvalSuite({ name: "${suite}", cases: [ … ] })`);
  if (caseNamesOf(cases).includes(draft.name))
    throw new ScaffoldConflictError(
      `${suite} already has a case named "${draft.name}" (${file.path}). Nothing was written — name the new one otherwise`,
    );
  const written = evalCaseSourceOf(draft, classes);
  const separator = cases.elements.length > 0 && !cases.elements.hasTrailingComma ? "," : "";
  const edits = [
    ...importEdits(source, written),
    { at: cases.elements.end, text: `${separator} ${written.text},` },
  ].sort((left, right) => right.at - left.at);
  const content = edits.reduce(
    (text, edit) => `${text.slice(0, edit.at)}${edit.text}${text.slice(edit.at)}`,
    file.content,
  );
  return { file: { path: file.path, content }, skipped: written.skipped };
}
