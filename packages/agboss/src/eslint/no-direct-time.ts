// Lint rule `agboss/no-direct-time` (#262 AC12, #388): every time read and every wait goes through
// the application's one `Clock` (infrastructure, #261), so a test's `VirtualClock` moves deadlines,
// 429 pauses, aging, leases and backoff with `clock.advance(…)` and nothing waits for real. Flags
// the direct ways to read the time or start a timer — `Date.now()`, `new Date()` and `Date()`
// without arguments, `performance.now()`, `setTimeout`, `setInterval`, `AbortSignal.timeout` and
// the `node:timers` modules — when they name the global (a local of the same name is not flagged).
// On for the framework's sources (the real `Clock`, src/infrastructure/clock.ts, excepted) and for
// a project's `src/` outside its tests (the config `agboss create` writes).
import { AST_NODE_TYPES, TSESLint, type TSESTree } from "@typescript-eslint/utils";

const ADVICE =
  "inject the application's Clock (`deps: [Clock]`) and read the time and wait through it (`clock.now()`, `clock.sleep(…)`), so a test's VirtualClock moves it (#262)";

/** Global members that read the time or start a timer: object → members. */
const MEMBERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Date", new Set(["now"])],
  ["performance", new Set(["now"])],
  ["AbortSignal", new Set(["timeout"])],
  ["globalThis", new Set(["setTimeout", "setInterval"])],
]);

/** Globals that are timers wherever they are named (called, passed or aliased). */
const TIMERS: ReadonlySet<string> = new Set(["setTimeout", "setInterval"]);

/** Modules whose exports are timers. */
const TIMER_MODULES: ReadonlySet<string> = new Set([
  "timers",
  "timers/promises",
  "node:timers",
  "node:timers/promises",
]);

const GLOBALS: ReadonlySet<string> = new Set([...MEMBERS.keys(), ...TIMERS]);

/** The TypeScript nodes that hold types only: a name inside one reads no value. */
const TYPE_NODES: ReadonlySet<AST_NODE_TYPES> = new Set([
  AST_NODE_TYPES.TSTypeAnnotation,
  AST_NODE_TYPES.TSTypeQuery,
  AST_NODE_TYPES.TSTypeReference,
  AST_NODE_TYPES.TSTypeAliasDeclaration,
  AST_NODE_TYPES.TSInterfaceDeclaration,
  AST_NODE_TYPES.TSTypeParameterInstantiation,
]);

/** The message of the rule. */
export type DirectTimeMessageId = "direct";

/** What a reference reads directly, as the message names it: `Date.now`, `new Date()`, … */
type DirectTime = string;

/** Whether a name sits in a type (`typeof setTimeout`, `: Date`), by its ancestors: no value is read there. */
const isInType = (ancestors: readonly TSESTree.Node[]): boolean =>
  ancestors.some((ancestor) => TYPE_NODES.has(ancestor.type));

const memberName = (member: TSESTree.MemberExpression): string | undefined => {
  if (!member.computed && member.property.type === AST_NODE_TYPES.Identifier)
    return member.property.name;
  return member.property.type === AST_NODE_TYPES.Literal
    ? String(member.property.value)
    : undefined;
};

/** `Date.now`, `performance.now`, …: a member of a global that reads the time or starts a timer. */
function directMemberOf(
  identifier: TSESTree.Identifier,
  member: TSESTree.MemberExpression,
): DirectTime | undefined {
  const name = memberName(member);
  const isDirect = name !== undefined && MEMBERS.get(identifier.name)?.has(name) === true;
  return isDirect ? `${identifier.name}.${name}` : undefined;
}

/** `new Date()` or `Date()` without arguments: the current time. */
function currentDateOf(identifier: TSESTree.Identifier): DirectTime | undefined {
  const { parent } = identifier;
  if (parent.type === AST_NODE_TYPES.NewExpression && parent.callee === identifier)
    return parent.arguments.length === 0 ? "new Date()" : undefined;
  return parent.type === AST_NODE_TYPES.CallExpression && parent.callee === identifier
    ? "Date()"
    : undefined;
}

/** What a reference to a global reads, when it is direct time; else undefined. */
function directTimeOf(identifier: TSESTree.Identifier): DirectTime | undefined {
  const { name, parent } = identifier;
  if (TIMERS.has(name)) return name;
  if (parent.type === AST_NODE_TYPES.MemberExpression && parent.object === identifier) {
    return directMemberOf(identifier, parent);
  }
  return name === "Date" ? currentDateOf(identifier) : undefined;
}

/**
 * Every reference to a global: unresolved, or resolved to a variable of the global scope with no
 * declaration in the file (TypeScript's lib globals such as `Date` and `globalThis`).
 */
function globalReferences(scopeManager: TSESLint.Scope.ScopeManager): TSESLint.Scope.Reference[] {
  const isGlobal = (variable: TSESLint.Scope.Variable | null): boolean =>
    variable === null ||
    (variable.scope.type === TSESLint.Scope.ScopeType.global && variable.defs.length === 0);
  return scopeManager.scopes.flatMap((scope) =>
    scope.references.filter((reference) => isGlobal(reference.resolved)),
  );
}

export const noDirectTime: TSESLint.RuleModule<DirectTimeMessageId> = {
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: { description: "No direct time: the application's Clock only" },
    messages: { direct: "`{{what}}` reads the time directly: {{advice}}." },
    schema: [],
  },
  create(context) {
    const report = (node: TSESTree.Node, what: DirectTime): void => {
      context.report({ node, messageId: "direct", data: { what, advice: ADVICE } });
    };
    return {
      ImportDeclaration: (node) => {
        if (TIMER_MODULES.has(node.source.value)) report(node, `import "${node.source.value}"`);
      },
      "Program:exit": () => {
        const { scopeManager } = context.sourceCode;
        if (scopeManager === null) return;
        for (const reference of globalReferences(scopeManager)) {
          const { identifier } = reference;
          if (identifier.type !== AST_NODE_TYPES.Identifier || !GLOBALS.has(identifier.name))
            continue;
          if (reference.isTypeReference) continue;
          if (isInType(context.sourceCode.getAncestors(identifier))) continue;
          const what = directTimeOf(identifier);
          if (what !== undefined) report(identifier, what);
        }
      },
    };
  },
};
