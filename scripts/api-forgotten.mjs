// The forgotten-export check of the API reports (#895). api-extractor reports a symbol that a
// signature uses and the entry point being reported does not export (`ae-forgotten-export`) — but
// a type exported by ANOTHER public entry (`Bytes` from the root, used by `@agboss/core/a2a`) is
// not a hole: a user imports it from there. So the reports leave that message out, and this check
// fails on a symbol that NO public entry exports (`internalExports` do not count): a user could
// name the type of a signature nowhere. Runs on the compiler's symbols of one shared program.
import { createRequire } from "node:module";
import { join, relative } from "node:path";

// the TypeScript api-extractor analyses with: its syntax-kind numbers are the program's
const ts = createRequire(createRequire(import.meta.url).resolve("@microsoft/api-extractor"))(
  "typescript",
);

const SYMBOL = /^The symbol "([^"]+)" needs to be exported/;

/** `messageCallback` of one entry that records the names of its forgotten exports into `found`. */
export function recordForgotten(found, subpath) {
  return (message) => {
    const name = SYMBOL.exec(message.text)?.[1];
    if (message.messageId === "ae-forgotten-export" && name) {
      found.push({ subpath, name });
      message.handled = true;
    }
  };
}

const resolved = (checker, symbol) =>
  symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

/** The symbols an entry file exports, aliases followed; a namespace re-export brings its members. */
function exportedBy(checker, source, into = new Set()) {
  const module = checker.getSymbolAtLocation(source);
  if (!module) throw new Error(`${source.fileName} is not a module of the analysed program`);
  for (const each of checker.getExportsOfModule(module)) {
    const symbol = resolved(checker, each);
    into.add(symbol);
    if (
      symbol.flags & ts.SymbolFlags.ValueModule &&
      symbol.valueDeclaration?.kind === ts.SyntaxKind.SourceFile
    ) {
      checker.getExportsOfModule(symbol).forEach((member) => into.add(resolved(checker, member)));
    }
  }
  return into;
}

/** The symbols of the package's own declarations a signature reachable from `roots` names. */
function reachableFrom(checker, roots, own) {
  const seen = new Set();
  const queue = [...roots];
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const found = checker.getSymbolAtLocation(node);
      const symbol = found && resolved(checker, found);
      if (symbol && !seen.has(symbol)) queue.push(symbol);
    }
    ts.forEachChild(node, visit);
  };
  while (queue.length > 0) {
    const symbol = queue.pop();
    if (seen.has(symbol)) continue;
    const inside = (symbol.declarations ?? []).filter((d) => own(d.getSourceFile().fileName));
    if (inside.length === 0) continue;
    seen.add(symbol);
    inside.forEach(visit);
  }
  return seen;
}

/**
 * The forgotten exports no public entry exports: `[{ subpath, name, files }]`. For each entry with a
 * finding the symbols its exports reach are walked, so a name two declarations share is told
 * apart: only the declaration the entry really uses counts.
 */
export function unexportedByAnyEntry({ program, root, entries, publicSubpaths, found }) {
  const checker = program.getTypeChecker();
  const own = (file) =>
    file.startsWith(join(root, "dist") + "/") && !file.includes("/node_modules/");
  const sourceOf = (entry) => program.getSourceFile(entry.file);
  const exportedPublicly = new Set();
  for (const entry of entries.filter((e) => publicSubpaths.includes(e.subpath))) {
    exportedBy(checker, sourceOf(entry), exportedPublicly);
  }
  const holes = [];
  for (const entry of entries.filter((e) => found.some((f) => f.subpath === e.subpath))) {
    const reached = reachableFrom(checker, [...exportedBy(checker, sourceOf(entry))], own);
    const topLevel = [...reached].filter((symbol) =>
      symbol.declarations?.some(
        (d) => d.parent && ts.isSourceFile(d.parent) && own(d.getSourceFile().fileName),
      ),
    );
    for (const { subpath, name } of found.filter((f) => f.subpath === entry.subpath)) {
      const bare = name.replace(/_\d+$/, "");
      const named = topLevel.filter((symbol) => symbol.name === name || symbol.name === bare);
      if (!publicSubpaths.includes(subpath)) continue;
      if (named.length === 0 || named.some((symbol) => !exportedPublicly.has(symbol))) {
        const files = named.map((symbol) =>
          relative(root, symbol.declarations[0].getSourceFile().fileName),
        );
        holes.push({ subpath, name, files });
      }
    }
  }
  return holes;
}
