import ts from "typescript";
import { ScaffoldConflictError } from "./errors.js";
import { addImport, identityOf } from "./wire.js";
import type { FileToWrite } from "./write.js";

/**
 * What generators (and people) wire into a component's decorator: `--force` regenerates the file and
 * keeps all of it (#237) — tools, knowledge bases, MCP servers, judges, guardrails, routes, the flow.
 */
const KEPT = [
  "tools",
  "rag",
  "mcp",
  "judges",
  "guardrails",
  "excludeGuardrails",
  "piiPolicies",
  "excludePiiPolicies",
  "routes",
  "flow",
  "providers",
  "observers",
] as const;
/** Wiring that goes with code the template rewrites (`deps` ↔ the constructor): never dropped silently. */
const NOT_KEPT = ["deps"] as const;

interface Property {
  readonly decorator: string;
  readonly name: string;
  readonly value: ts.Expression;
}

const parse = (text: string, file: string): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

/** `@<decorator>({ <name>: <value> })` of every decorator call in the file. */
function propertiesOf(source: ts.SourceFile): Property[] {
  const found: Property[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isDecorator(node) && ts.isCallExpression(node.expression)) {
      const {
        expression: callee,
        arguments: [options],
      } = node.expression;
      if (ts.isIdentifier(callee) && options !== undefined && ts.isObjectLiteralExpression(options))
        for (const p of options.properties.filter(ts.isPropertyAssignment))
          if (ts.isIdentifier(p.name))
            found.push({ decorator: callee.text, name: p.name.text, value: p.initializer });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const elementsOf = (value: ts.Expression): readonly ts.Expression[] =>
  ts.isArrayLiteralExpression(value) ? value.elements : [value];

const idsOf = (value: ts.Expression | undefined): string[] =>
  value === undefined ? [] : elementsOf(value).map(identityOf);

/** The old wiring the regenerated property lacks; empty = the new file already has all of it. */
const lostOf = (old: Property, now: Property | undefined): string[] => {
  const kept = idsOf(now?.value);
  return idsOf(old.value).filter((id) => !kept.includes(id));
};

/** The new file's `@<decorator>({ <name> })`, if it has one. */
const propertyIn = (source: ts.SourceFile, old: Property): Property | undefined =>
  propertiesOf(source).find((p) => p.decorator === old.decorator && p.name === old.name);

/** The old elements, then the new ones the old file does not have — as the property's new value. */
function mergedValue(old: Property, now: Property | undefined): string {
  if (!ts.isArrayLiteralExpression(old.value)) return old.value.getText();
  const oldIds = idsOf(old.value);
  const added = (now === undefined ? [] : elementsOf(now.value))
    .filter((e) => !oldIds.includes(identityOf(e)))
    .map((e) => e.getText());
  return `[${[...old.value.elements.map((e) => e.getText()), ...added].join(", ")}]`;
}

/** Names an element refers to (not property names): the imports it needs. */
function referencedNames(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (n: ts.Node): void => {
    const parent = n.parent;
    const isKey =
      (ts.isPropertyAssignment(parent) && parent.name === n) ||
      (ts.isPropertyAccessExpression(parent) && parent.name === n);
    if (ts.isIdentifier(n) && !isKey) names.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return names;
}

/** `name` → the module the old file imports it from (named imports). */
function importsOf(source: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const declaration of source.statements.filter(ts.isImportDeclaration)) {
    const named = declaration.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    if (!ts.isStringLiteral(declaration.moduleSpecifier)) continue;
    for (const element of named.elements)
      map.set(element.name.text, declaration.moduleSpecifier.text);
  }
  return map;
}

/** The options object of the file's first `@<decorator>({ … })`. */
function optionsOf(
  source: ts.SourceFile,
  decorator: string,
): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isDecorator(node) && ts.isCallExpression(node.expression)) {
      const {
        expression: callee,
        arguments: [options],
      } = node.expression;
      if (ts.isIdentifier(callee) && callee.text === decorator && options !== undefined)
        found = ts.isObjectLiteralExpression(options) ? options : undefined;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The new file with the old wiring of one property (the value replaced, or the property added). */
function withKept(text: string, file: string, old: Property): string {
  const source = parse(text, file);
  const now = propertyIn(source, old);
  const value = mergedValue(old, now);
  if (now !== undefined)
    return `${text.slice(0, now.value.getStart(source))}${value}${text.slice(now.value.getEnd())}`;
  const last = optionsOf(source, old.decorator)?.properties.at(-1);
  if (last === undefined) return text;
  return `${text.slice(0, last.getEnd())},\n  ${old.name}: ${value}${text.slice(last.getEnd())}`;
}

/** The imports the kept wiring needs, from the old file's imports; names the new file has are left. */
function withImports(text: string, file: string, old: Property, imports: Map<string, string>) {
  let content = text;
  for (const name of referencedNames(old.value)) {
    const from = imports.get(name);
    if (from !== undefined && !importsOf(parse(content, file)).has(name))
      content = addImport(content, file, name, from);
  }
  return content;
}

/** What `--force` writes for an existing file: the regenerated one, with the old file's wiring. */
export interface Kept {
  readonly file: FileToWrite;
  /** `path: property [A, B]` — the wiring carried over */
  readonly kept: readonly string[];
}

const describeLost = (path: string, old: Property, lost: readonly string[]): string =>
  `${path}: ${old.name} [${lost.join(", ")}]`;

/** The old file's properties the regenerated file would lose, split into keepable and not. */
function losses(oldSource: ts.SourceFile, newSource: ts.SourceFile) {
  const now = propertiesOf(newSource);
  return propertiesOf(oldSource).flatMap((old) => {
    const known = [...KEPT, ...NOT_KEPT] as readonly string[];
    if (!known.includes(old.name)) return [];
    const lost = lostOf(
      old,
      now.find((p) => p.decorator === old.decorator && p.name === old.name),
    );
    return lost.length === 0 ? [] : [{ old, lost }];
  });
}

/**
 * `--force` on a file that exists (#237): the regenerated file keeps the wiring of the old one (its
 * elements first, then the template's new ones, with their imports). Wiring it cannot keep (`deps`,
 * which go with the constructor the template rewrites) → a conflict naming it; nothing is written.
 */
export function keepWiring(old: string, regenerated: FileToWrite): Kept {
  const oldSource = parse(old, regenerated.path);
  const found = losses(oldSource, parse(regenerated.content, regenerated.path));
  const dropped = found.filter((l) => (NOT_KEPT as readonly string[]).includes(l.old.name));
  if (dropped.length > 0)
    throw new ScaffoldConflictError(
      `${dropped.map((l) => describeLost(regenerated.path, l.old, l.lost)).join("; ")} cannot be kept: the regenerated file rewrites the constructor they go with. Nothing was written — keep the file and edit it by hand; --force --reset overwrites it and drops that wiring`,
    );
  const imports = importsOf(oldSource);
  const content = found.reduce(
    (text, { old: property }) =>
      withImports(withKept(text, regenerated.path, property), regenerated.path, property, imports),
    regenerated.content,
  );
  const kept = found.map((l) => describeLost(regenerated.path, l.old, l.lost));
  return { file: { ...regenerated, content }, kept };
}
