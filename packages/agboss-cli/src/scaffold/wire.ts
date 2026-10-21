import ts from "typescript";
import { ScaffoldConflictError, ScaffoldError } from "./errors.js";
import type { FileToWrite } from "./write.js";

type Decorator = "Agent" | "Workflow" | "Router" | "Application";

const decoratorCall = (
  source: ts.SourceFile,
  decorator: Decorator,
): ts.ObjectLiteralExpression | undefined => {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isDecorator(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      const [options] = call.arguments;
      if (
        ts.isIdentifier(call.expression) &&
        call.expression.text === decorator &&
        options !== undefined &&
        ts.isObjectLiteralExpression(options)
      ) {
        found = options;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const parse = (text: string, file: string): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

/**
 * What an array element wires, by identifier (#197): `X` → X, `{ prompt, target: X }` → X,
 * `{ use: X, mode }` → X, `route(X, "…")` → X; anything else by its text.
 */
export function identityOf(element: ts.Expression): string {
  if (ts.isIdentifier(element)) return element.text;
  if (ts.isObjectLiteralExpression(element)) {
    const key = element.properties
      .filter(ts.isPropertyAssignment)
      .find((p) => ts.isIdentifier(p.name) && ["target", "use"].includes(p.name.text));
    if (key !== undefined && ts.isIdentifier(key.initializer)) return key.initializer.text;
  }
  const [first] = ts.isCallExpression(element) ? element.arguments : [];
  if (first !== undefined && ts.isIdentifier(first)) return first.text;
  return element.getText().replace(/\s+/g, " ");
}

const identityOfText = (element: string): string => {
  const statement = parse(`(${element});`, "element.ts").statements[0];
  if (statement === undefined || !ts.isExpressionStatement(statement)) return element;
  const expression = statement.expression;
  return identityOf(ts.isParenthesizedExpression(expression) ? expression.expression : expression);
};

/** The `property` array of the file's `@<decorator>({…})` (undefined: no such property yet). */
function arrayOf(
  text: string,
  file: string,
  decorator: Decorator,
  property: string,
  element: string,
): {
  source: ts.SourceFile;
  options: ts.ObjectLiteralExpression;
  array?: ts.ArrayLiteralExpression;
} {
  const source = parse(text, file);
  const options = decoratorCall(source, decorator);
  if (options === undefined)
    throw new ScaffoldError(`${file}: no @${decorator}({ … }) found — add ${element} by hand`);
  const assignment = options.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === property,
  );
  if (assignment === undefined) return { source, options };
  if (!ts.isArrayLiteralExpression(assignment.initializer)) {
    throw new ScaffoldError(
      `${file}: @${decorator}({ ${property} }) is not an array literal — add ${element} by hand`,
    );
  }
  return { source, options, array: assignment.initializer };
}

/** Whether the array already wires what `element` wires (same identifier). */
export function isWired(
  text: string,
  file: string,
  decorator: Decorator,
  property: string,
  element: string,
): boolean {
  const { array } = arrayOf(text, file, decorator, property, element);
  const wanted = identityOfText(element);
  return array?.elements.some((e) => identityOf(e) === wanted) ?? false;
}

/** Where the new element goes: before the first of `before` (a finish route), else after the last. */
function placement(
  source: ts.SourceFile,
  array: ts.ArrayLiteralExpression,
  element: string,
  before: readonly string[],
): { at: number; text: string } {
  const text = source.text;
  const indentAt = (node: ts.Node): string => {
    const start = node.getStart(source);
    return /[ \t]*$/.exec(text.slice(text.lastIndexOf("\n", start - 1) + 1, start))?.[0] ?? "";
  };
  const multiline = array.getText(source).includes("\n");
  const next = array.elements.find((e) => before.includes(identityOf(e)));
  if (next !== undefined) {
    const gap = multiline ? `,\n${indentAt(next)}` : ", ";
    return { at: next.getStart(source), text: `${element}${gap}` };
  }
  const last = array.elements.at(-1);
  if (last === undefined) return { at: array.getStart(source) + 1, text: element };
  return { at: last.getEnd(), text: `${multiline ? `,\n${indentAt(last)}` : ", "}${element}` };
}

/**
 * Adds `element` to the `property` array of the file's `@Agent({…})` / `@Workflow({…})` / `@Router({…})`
 * options (the property is created when missing), before the first element wiring one of `before`.
 * An element wiring the same identifier → a clash; an unexpected shape → an error naming the file.
 */
export function addToArray(
  text: string,
  file: string,
  decorator: Decorator,
  property: string,
  element: string,
  before: readonly string[] = [],
): string {
  const { source, options, array } = arrayOf(text, file, decorator, property, element);
  if (array === undefined) {
    const last = options.properties.at(-1);
    const at = last === undefined ? options.getStart(source) + 1 : last.getEnd();
    return `${text.slice(0, at)}${last === undefined ? "" : ","}\n  ${property}: [${element}]${text.slice(at)}`;
  }
  if (isWired(text, file, decorator, property, element))
    throw new ScaffoldConflictError(
      `${file}: ${identityOfText(element)} is already in ${property}`,
    );
  const insert = placement(source, array, element, before);
  return `${text.slice(0, insert.at)}${insert.text}${text.slice(insert.at)}`;
}

const importFrom = (source: ts.SourceFile, from: string): ts.NamedImports | undefined => {
  const declaration = source.statements
    .filter(ts.isImportDeclaration)
    .find((i) => ts.isStringLiteral(i.moduleSpecifier) && i.moduleSpecifier.text === from);
  const named = declaration?.importClause?.namedBindings;
  return named !== undefined && ts.isNamedImports(named) ? named : undefined;
};

/** Adds `import { name } from "from"` — into an existing import from the same module when there is one. */
export function addImport(text: string, file: string, name: string, from: string): string {
  const source = parse(text, file);
  const named = importFrom(source, from);
  if (named !== undefined) {
    if (named.elements.some((e) => e.name.text === name)) return text;
    const at = named.elements.at(-1)?.getEnd() ?? named.getStart(source) + 1;
    return `${text.slice(0, at)}, ${name}${text.slice(at)}`;
  }
  const at = source.statements.filter(ts.isImportDeclaration).at(-1)?.getEnd() ?? 0;
  const line = `import { ${name} } from "${from}";`;
  return at === 0 ? `${line}\n${text}` : `${text.slice(0, at)}\n${line}${text.slice(at)}`;
}

/** Where a wiring goes: the decorator's array, the element, its import, what it goes before. */
export interface Wiring {
  readonly decorator: Decorator;
  readonly property: string;
  readonly element: string;
  readonly name: string;
  readonly from: string;
  readonly before?: readonly string[];
}

/**
 * Wires a class into an agent, router or workflow file: the array entry and its import. Already wired
 * (the same identifier) → the file unchanged and the wiring reported as skipped, never doubled.
 */
export function wireInto(file: FileToWrite, w: Wiring): FileToWrite {
  if (isWired(file.content, file.path, w.decorator, w.property, w.element)) {
    const note = `${file.path}: ${w.name} already in ${w.property}`;
    return { ...file, skipped: [...(file.skipped ?? []), note] };
  }
  const added = addToArray(file.content, file.path, w.decorator, w.property, w.element, w.before);
  return { ...file, content: addImport(added, file.path, w.name, w.from) };
}

/** `wireInto` with positional arguments. */
export const wire = (
  file: FileToWrite,
  decorator: Decorator,
  property: string,
  element: string,
  name: string,
  from: string,
): FileToWrite => wireInto(file, { decorator, property, element, name, from });
