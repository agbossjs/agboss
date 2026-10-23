import ts from "typescript";
import { ScaffoldError } from "./errors.js";
import type { CaseSource } from "./eval-case-source.js";
import { importPath } from "./workflow-graph.js";

/**
 * The imports an eval case written into a suite needs (#396 PR 8): the builders added to the file's
 * import of `EvalSuite`, each class into the file's import of its module, else a new import.
 */

/** A text edit: `text` put at `at`. */
export interface Edit {
  readonly at: number;
  readonly text: string;
}

/** Every identifier the file imports. */
const importedNames = (source: ts.SourceFile): ReadonlySet<string> =>
  new Set(
    source.statements.filter(ts.isImportDeclaration).flatMap((declaration) => {
      const named = declaration.importClause?.namedBindings;
      return named !== undefined && ts.isNamedImports(named)
        ? named.elements.map((element) => element.name.text)
        : [];
    }),
  );

/** The file's import of the eval builders: the one that brings `EvalSuite`. */
function evalImportOf(source: ts.SourceFile): ts.NamedImports {
  for (const declaration of source.statements.filter(ts.isImportDeclaration)) {
    const named = declaration.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    if (named.elements.some((element) => element.name.text === "EvalSuite")) return named;
  }
  throw new ScaffoldError(`${source.fileName} does not import EvalSuite`);
}

/** The file's named imports by module specifier. */
function namedImportsOf(source: ts.SourceFile): ReadonlyMap<string, ts.NamedImports> {
  const found = new Map<string, ts.NamedImports>();
  for (const declaration of source.statements.filter(ts.isImportDeclaration)) {
    const named = declaration.importClause?.namedBindings;
    const isTypeOnly = declaration.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
    if (named === undefined || !ts.isNamedImports(named) || isTypeOnly) continue;
    if (ts.isStringLiteral(declaration.moduleSpecifier))
      found.set(declaration.moduleSpecifier.text, named);
  }
  return found;
}

/** The classes the case uses that the file does not import yet, by import specifier. */
function missingClasses(source: ts.SourceFile, written: CaseSource): Map<string, Set<string>> {
  const imported = importedNames(source);
  const bySpecifier = new Map<string, Set<string>>();
  for (const found of written.classes) {
    if (imported.has(found.className)) continue;
    const specifier = importPath(source.fileName, found.path);
    const names = bySpecifier.get(specifier) ?? new Set<string>();
    bySpecifier.set(specifier, names.add(found.className));
  }
  return bySpecifier;
}

/** Names appended to an import's list: after its trailing comma, or after a new one. */
const listAfter = (named: ts.NamedImports, names: readonly string[]): string =>
  `${named.elements.hasTrailingComma ? " " : ", "}${names.join(", ")}`;

/** The edits that import what the case uses: into an import of its module, else a new one. */
export function importEdits(source: ts.SourceFile, written: CaseSource): Edit[] {
  const imported = importedNames(source);
  const builders = written.builders.filter((name) => !imported.has(name));
  const named = evalImportOf(source);
  const edits: Edit[] =
    builders.length === 0 ? [] : [{ at: named.elements.end, text: listAfter(named, builders) }];
  const existing = namedImportsOf(source);
  const added: string[] = [];
  for (const [specifier, names] of missingClasses(source, written)) {
    const into = existing.get(specifier);
    if (into === undefined)
      added.push(`import { ${[...names].sort().join(", ")} } from "${specifier}";\n`);
    else edits.push({ at: into.elements.end, text: listAfter(into, [...names].sort()) });
  }
  const last = source.statements.filter(ts.isImportDeclaration).at(-1);
  if (added.length > 0)
    edits.push({ at: last === undefined ? 0 : last.end + 1, text: added.join("") });
  return edits;
}
