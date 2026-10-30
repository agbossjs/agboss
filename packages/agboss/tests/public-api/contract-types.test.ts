/**
 * #511 AC4: a store outside the core implements an infrastructure contract on the public surface
 * alone — every type a contract's members name (and the data shapes those name in turn) is
 * importable from the root entry, never derived with `Parameters` / `ReturnType` from the class.
 * The contracts are the application's infrastructure (`INFRASTRUCTURE_DEFAULTS`), so a new one is
 * checked as soon as it is registered.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { INFRASTRUCTURE_DEFAULTS } from "../../src/infrastructure/contracts.js";

const src = new URL("../../src/", import.meta.url).pathname;
const root = `${src}index.ts`;
const program = ts.createProgram([root], {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2023,
  strict: true,
  experimentalDecorators: false,
});
const checker = program.getTypeChecker();

/** What a symbol stands for: an alias's target; an enum member (`Kind.Takeover` as a type) its enum. */
function targetOf(symbol: ts.Symbol): ts.Symbol {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const member = target.declarations?.[0];
  if (member === undefined || !ts.isEnumMember(member)) return target;
  return checker.getSymbolAtLocation(member.parent.name) ?? target;
}

/** The declaration a symbol stands for: `infrastructure/execution-record.repository.ts#Tern`. */
const keyOf = (symbol: ts.Symbol): string | undefined => {
  const file = targetOf(symbol).declarations?.[0]?.getSourceFile().fileName;
  return file?.startsWith(src) === true ? `${file.slice(src.length)}#${symbol.name}` : undefined;
};

const rootSource = program.getSourceFile(root);
if (rootSource === undefined) throw new Error(`not in the program: ${root}`);
const rootModule = checker.getSymbolAtLocation(rootSource);
const rootExports = rootModule === undefined ? [] : checker.getExportsOfModule(rootModule);
const exported = new Set(rootExports.map((symbol) => keyOf(targetOf(symbol))));

/** A member an implementer writes or calls: not `private`, not `#private`. */
const isOwnMember = (member: ts.ClassElement): boolean =>
  (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Private) === 0 &&
  !(member.name !== undefined && ts.isPrivateIdentifier(member.name));

/** The named types of the core a piece of syntax refers to, and, through data shapes, theirs. */
function namedTypesIn(node: ts.Node, found: Map<string, ts.Symbol>): void {
  const visit = (at: ts.Node): void => {
    if (ts.isTypeReferenceNode(at) || ts.isExpressionWithTypeArguments(at)) {
      const name = ts.isTypeReferenceNode(at) ? at.typeName : at.expression;
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol !== undefined) record(targetOf(symbol), found);
    }
    ts.forEachChild(at, visit);
  };
  visit(node);
}

function record(symbol: ts.Symbol, found: Map<string, ts.Symbol>): void {
  if (symbol.flags & ts.SymbolFlags.TypeParameter) return;
  const key = keyOf(symbol);
  if (key === undefined || found.has(key)) return;
  found.set(key, symbol);
  // a data shape's own fields are part of what an implementer writes; a class is its own surface
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)) {
      namedTypesIn(declaration, found);
    }
  }
}

/** Every named type of the core a contract's non-private members name. */
function contractTypesOf(name: string): Map<string, ts.Symbol> {
  const symbol = rootExports.find((exportedSymbol) => exportedSymbol.name === name);
  const contract = symbol === undefined ? undefined : targetOf(symbol);
  const declaration = contract?.declarations?.[0];
  if (contract === undefined || declaration === undefined || !ts.isClassDeclaration(declaration)) {
    throw new Error(`${name} is not a class exported by the root entry`);
  }
  const found = new Map<string, ts.Symbol>();
  for (const member of declaration.members.filter(isOwnMember)) namedTypesIn(member, found);
  found.delete(keyOf(contract) ?? "");
  return found;
}

/** The contracts declared in the core (LangGraph's `BaseCheckpointSaver` is LangGraph's). */
const CONTRACTS = [...INFRASTRUCTURE_DEFAULTS.keys()]
  .map((contract) => contract.name)
  .filter((name) => rootExports.some((symbol) => symbol.name === name && keyOf(symbol)));

describe("#511 AC4: every type a public infrastructure contract names is exported", () => {
  it("AC4: the contracts checked are the application's infrastructure", () => {
    expect(CONTRACTS).toEqual(
      expect.arrayContaining([
        "Clock",
        "ExecutionRecordRepository",
        "ExecutionLeaseRepository",
        "FencedEffectRepository",
        "ExecutionLeaseEventRepository",
      ]),
    );
  });

  it.each(CONTRACTS)("AC4: %s names only types the root entry exports", (name) => {
    const missing = [...contractTypesOf(name).keys()].filter((key) => !exported.has(key));

    expect(missing).toEqual([]);
  });

  it("AC4: the record types of ExecutionRecordRepository are importable from the root entry", () => {
    const names = new Set(rootExports.map((symbol) => symbol.name));

    for (const name of [
      "Tern",
      "NewTern",
      "TernOutcome",
      "Summary",
      "NewSummary",
      "ConfigSnapshot",
      "VersionScore",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });
});
