// Local lint rule (#262 AC12): every time the framework reads and every wait it makes goes through
// the application's one `Clock` (infrastructure, #261), so a test's `VirtualClock` moves deadlines,
// 429 pauses, aging, leases and backoff with `clock.advance(…)` and nothing waits for real. Flags
// the direct ways to read the time or start a timer in framework code — `Date.now()`, `new Date()`
// and `Date()` without arguments, `performance.now()`, `setTimeout`, `setInterval`,
// `AbortSignal.timeout` and the `node:timers` modules — when they name the global (a local of the
// same name is not flagged). The real `Clock` implementation (src/infrastructure/clock.ts) is the
// one file it does not apply to.

const ADVICE =
  "read the time and wait through the application's Clock (`clock.now()`, `clock.sleep(…)`, `timeoutOn(clock, …)`), so a test's VirtualClock moves it (#262)";

/** Global members that read the time or start a timer: object → members. */
const MEMBERS = new Map([
  ["Date", new Set(["now"])],
  ["performance", new Set(["now"])],
  ["AbortSignal", new Set(["timeout"])],
  ["globalThis", new Set(["setTimeout", "setInterval"])],
]);

/** Globals that are timers wherever they are named (called, passed or aliased). */
const TIMERS = new Set(["setTimeout", "setInterval"]);

/** Modules whose exports are timers. */
const TIMER_MODULES = new Set(["timers", "timers/promises", "node:timers", "node:timers/promises"]);

const GLOBALS = new Set([...MEMBERS.keys(), ...TIMERS]);

/** The TypeScript nodes that hold types only: a name inside one reads no value. */
const TYPE_NODES = new Set([
  "TSTypeAnnotation",
  "TSTypeQuery",
  "TSTypeReference",
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSTypeParameterInstantiation",
]);

/** Whether the identifier sits in a type (`typeof setTimeout`, `: Date`): no value is read there. */
function isInType(identifier) {
  for (let at = identifier.parent; at !== null && at !== undefined; at = at.parent) {
    if (TYPE_NODES.has(at.type)) return true;
  }
  return false;
}

const memberName = (member) =>
  !member.computed && member.property.type === "Identifier"
    ? member.property.name
    : member.property.type === "Literal"
      ? String(member.property.value)
      : undefined;

/** `Date.now`, `performance.now`, …: a member of a global that reads the time or starts a timer. */
function directMemberOf(identifier) {
  const member = memberName(identifier.parent);
  const isDirect = member !== undefined && MEMBERS.get(identifier.name)?.has(member) === true;
  return isDirect ? `${identifier.name}.${member}` : undefined;
}

/** `new Date()` or `Date()` without arguments: the current time. */
function currentDateOf(identifier) {
  const { parent } = identifier;
  if (parent.callee !== identifier) return undefined;
  if (parent.type === "NewExpression" && parent.arguments.length === 0) return "new Date()";
  return parent.type === "CallExpression" ? "Date()" : undefined;
}

/** What a reference to a global reads, when it is direct time; else undefined. */
function directTimeOf(identifier) {
  const { name, parent } = identifier;
  if (TIMERS.has(name)) return name;
  if (parent.type === "MemberExpression" && parent.object === identifier) {
    return directMemberOf(identifier);
  }
  return name === "Date" ? currentDateOf(identifier) : undefined;
}

/**
 * Every reference to a global: unresolved, or resolved to a variable of the global scope with no
 * declaration in the file (TypeScript's lib globals such as `Date` and `globalThis`).
 */
function globalReferences(scopeManager) {
  const isGlobal = (variable) =>
    variable === null || (variable.scope.type === "global" && variable.defs.length === 0);
  return scopeManager.scopes.flatMap((scope) =>
    scope.references.filter((reference) => isGlobal(reference.resolved)),
  );
}

export const noDirectTime = {
  meta: {
    type: "problem",
    docs: { description: "No direct time in framework code: the application's Clock only" },
    messages: { direct: "`{{what}}` in framework code: {{advice}}." },
    schema: [],
  },
  create(context) {
    const report = (node, what) =>
      context.report({ node, messageId: "direct", data: { what, advice: ADVICE } });
    return {
      ImportDeclaration: (node) => {
        if (TIMER_MODULES.has(String(node.source.value)))
          report(node, `import "${node.source.value}"`);
      },
      "Program:exit": () => {
        for (const reference of globalReferences(context.sourceCode.scopeManager)) {
          const { identifier } = reference;
          if (!GLOBALS.has(identifier.name) || reference.isTypeReference === true) continue;
          if (isInType(identifier)) continue;
          const what = directTimeOf(identifier);
          if (what !== undefined) report(identifier, what);
        }
      },
    };
  },
};
