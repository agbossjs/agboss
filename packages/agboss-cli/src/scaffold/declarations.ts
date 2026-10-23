import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path/posix";
import ts from "typescript";
import type { Component } from "./workflow-graph.js";

/**
 * The decorated classes of a project's sources, by their component `name` (#396 PR 8): read from
 * the files, never run — where a generator finds the class of a start, a finish or a tool it only
 * knows by name (a record names components, a case imports classes).
 */

const isSkipped = (name: string): boolean =>
  name === "node_modules" || name.startsWith(".") || name === "dist";

/** Every TypeScript source under `dir` (no tests, no declarations), relative to `root`. */
function sourcesIn(root: string, dir: string): string[] {
  const found: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      if (isSkipped(entry.name)) continue;
      const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !/\.(d|test|spec)\.ts$/.test(entry.name))
        found.push(path);
    }
  };
  walk(dir);
  return found;
}

/** The `name: "…"` of a decorator call's options. */
function nameOption(call: ts.CallExpression): string | undefined {
  const [options] = call.arguments;
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return undefined;
  const name = options.properties
    .filter(ts.isPropertyAssignment)
    .find((p) => ts.isIdentifier(p.name) && p.name.text === "name");
  return name !== undefined && ts.isStringLiteralLike(name.initializer)
    ? name.initializer.text
    : undefined;
}

/** The exported, decorated classes of one file. */
function classesOf(path: string, content: string): Component[] {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  return source.statements.filter(ts.isClassDeclaration).flatMap((declaration) => {
    const className = declaration.name?.text;
    const isExported = (ts.getModifiers(declaration) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    const call = (ts.getDecorators(declaration) ?? [])
      .map((decorator) => decorator.expression)
      .find(ts.isCallExpression);
    if (className === undefined || !isExported || call === undefined) return [];
    if (!ts.isIdentifier(call.expression)) return [];
    return [{ className, path, decorator: call.expression.text, id: nameOption(call) }];
  });
}

/** The decorated classes under `dir` (relative to `root`), each with its file relative to `root`. */
export function declarationsIn(root: string, dir: string): readonly Component[] {
  return sourcesIn(root, dir).flatMap((path) =>
    classesOf(path, readFileSync(join(root, path), "utf8")),
  );
}

/** The class named `name` (its decorator's `name`), of one of `decorators`. */
export const declarationNamed = (
  declarations: readonly Component[],
  name: string,
  decorators: readonly string[],
): Component | undefined =>
  declarations.find(
    (found) =>
      found.id === name && found.decorator !== undefined && decorators.includes(found.decorator),
  );
