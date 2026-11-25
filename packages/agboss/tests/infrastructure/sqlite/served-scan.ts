/**
 * The static half of #1317's guard (bug hunt 2026-11-25, finding 1): the gate of a SQLite repository
 * covers a method only up to its first `await`, so every statement after one must run inside
 * `connection.serve(…)` (or a hold's `trusted(…)`). This scan finds a statement of an async method
 * or function that runs after an `await` of it (a stream's body: everywhere) outside such a call.
 */
import ts from "typescript";

/** Calls whose callback arguments are served groups. */
const SERVING = new Set(["serve", "served", "trusted"]);

/** Calls that run a statement (or open a transaction) on a database or a prepared statement. */
const STATEMENT_CALLS = new Set(["run", "get", "all", "iterate", "exec", "prepare", "transaction"]);

/** Names through which code reaches a database: an argument named so hands it to a helper. */
const DATABASE_NAMES = new Set(["database", "db", "connection"]);

const nameOf = (node: ts.Node): string | undefined =>
  ts.isIdentifier(node) || ts.isPrivateIdentifier(node)
    ? node.text
    : ts.isPropertyAccessExpression(node)
      ? node.name.text
      : undefined;

/** The name a call is made by (`a.b.serve(…)` → `serve`, `this.#x(…)` → `#x`). */
const calleeOf = (call: ts.CallExpression): string | undefined => nameOf(call.expression);

const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node);

const isAsync = (node: ts.FunctionLikeDeclaration): boolean =>
  ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Async ? true : false;

const isLoop = (node: ts.Node): node is ts.IterationStatement =>
  ts.isForStatement(node) ||
  ts.isForOfStatement(node) ||
  ts.isForInStatement(node) ||
  ts.isWhileStatement(node) ||
  ts.isDoStatement(node);

/** Whether `node` holds an `await` of its own function (not of a nested one). */
function awaitsIn(node: ts.Node): boolean {
  if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) return true;
  if (isFunction(node)) return false;
  return ts.forEachChild(node, (child) => (awaitsIn(child) ? true : undefined)) ?? false;
}

/** `Promise.all(…)` and the like: never a statement. */
const isOnPromise = (call: ts.CallExpression): boolean =>
  ts.isPropertyAccessExpression(call.expression) &&
  ts.isIdentifier(call.expression.expression) &&
  call.expression.expression.text === "Promise";

/** Whether a call touches a database: a statement call, a database handed on, or a touching member. */
function touches(call: ts.CallExpression, members: ReadonlySet<string>): boolean {
  if (isOnPromise(call)) return false;
  const callee = calleeOf(call);
  if (callee !== undefined && (STATEMENT_CALLS.has(callee) || members.has(callee))) return true;
  return call.arguments.some((argument) => {
    const name = nameOf(argument);
    return name !== undefined && DATABASE_NAMES.has(name);
  });
}

interface Walk {
  readonly source: ts.SourceFile;
  readonly members: ReadonlySet<string>;
  readonly found: string[];
  isAfterAwait: boolean;
}

/** Walks `node` in evaluation order, recording each touching call made after an await. */
function walk(node: ts.Node, at: Walk): void {
  // a nested async function is scanned on its own; a synchronous callback runs where it is passed
  if (isFunction(node) && (isAsync(node) || !isCallback(node))) return;
  if (ts.isAwaitExpression(node)) {
    walk(node.expression, at);
    at.isAfterAwait = true;
    return;
  }
  if (isLoop(node) && awaitsIn(node)) at.isAfterAwait = true; // a later turn of it runs after one
  if (ts.isCallExpression(node)) {
    walkCall(node, at);
    return;
  }
  ts.forEachChild(node, (child) => {
    walk(child, at);
  });
}

const isCallback = (node: ts.Node): boolean =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node);

/** A call: its callee and arguments first (an `await` among them comes before the call), then itself. */
function walkCall(call: ts.CallExpression, at: Walk): void {
  const callee = calleeOf(call);
  walk(call.expression, at);
  if (callee !== undefined && SERVING.has(callee)) return; // its callbacks are served groups
  for (const argument of call.arguments) walk(argument, at);
  if (!at.isAfterAwait || !touches(call, at.members)) return;
  const { line } = at.source.getLineAndCharacterOfPosition(call.getStart(at.source));
  at.found.push(`${String(line + 1)}: ${call.getText(at.source).split("\n")[0] ?? ""}`);
}

/** The members of the file's classes whose bodies run a statement (to a fixpoint). */
function touchingMembers(source: ts.SourceFile): Set<string> {
  const bodies = new Map<string, ts.Node>();
  const collect = (node: ts.Node): void => {
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.body && node.name)
      bodies.set(nameOf(node.name) ?? "", node.body);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const members = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, body] of bodies) {
      if (members.has(name) || !callsIn(body).some((call) => touches(call, members))) continue;
      members.add(name);
      grew = true;
    }
  }
  return members;
}

function callsIn(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (at: ts.Node): void => {
    if (ts.isCallExpression(at)) calls.push(at);
    ts.forEachChild(at, visit);
  };
  visit(node);
  return calls;
}

/** Each statement of `text` that runs after an await of its async function, outside a served group. */
export function unservedStatementsOf(text: string): string[] {
  const source = ts.createSourceFile("scanned.ts", text, ts.ScriptTarget.Latest, true);
  const members = touchingMembers(source);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunction(node) && isAsync(node) && node.body) {
      const isStream = node.asteriskToken !== undefined;
      const at: Walk = { source, members, found, isAfterAwait: isStream };
      ts.forEachChild(node.body, (child) => {
        walk(child, at);
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
