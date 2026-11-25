import ts from "typescript";
import { ScaffoldError } from "./errors.js";
import { addImport } from "./wire.js";
import type { FileToWrite } from "./write.js";

/**
 * A router's choice in the flow (#272, #1278): `….toRouter(R).onRoute(toAgent(A)…).onRoute(…)` or
 * `onRouter(R).onRoute(…)…` — the router and the side paths its `.onRoute(…)`s list.
 */
export interface FlowCall {
  readonly router: string;
  readonly routes: readonly ts.Expression[];
  /** The last `.onRoute(…)` of the chain: where a new route goes after. */
  readonly last: ts.CallExpression;
}

const isCallOf = (node: ts.CallExpression, name: string): boolean =>
  (ts.isIdentifier(node.expression) && node.expression.text === name) ||
  (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === name);

const firstIdentifier = (call: ts.CallExpression): string | undefined => {
  const [first] = call.arguments;
  return first !== undefined && ts.isIdentifier(first) ? first.text : undefined;
};

/** The router the `.onRoute(…)` chain belongs to: the `toRouter(R)` / `onRouter(R)` it starts from. */
function routerOf(receiver: ts.Expression): string | undefined {
  if (!ts.isCallExpression(receiver)) return undefined;
  return isCallOf(receiver, "toRouter") || isCallOf(receiver, "onRouter")
    ? firstIdentifier(receiver)
    : undefined;
}

const isOnRoute = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.name.text === "onRoute";

/** The chain of `.onRoute(…)` calls ending at `last`, oldest first, and what it is called on. */
function chainOf(last: ts.CallExpression): {
  readonly routes: readonly ts.Expression[];
  readonly receiver: ts.Expression;
} {
  const routes: ts.Expression[] = [];
  let node: ts.Expression = last;
  while (isOnRoute(node) && ts.isPropertyAccessExpression(node.expression)) {
    routes.unshift(...node.arguments);
    node = node.expression.expression;
  }
  return { routes, receiver: node };
}

export function flowCalls(source: ts.SourceFile): FlowCall[] {
  const calls: FlowCall[] = [];
  const visit = (node: ts.Node): void => {
    // the outermost `.onRoute(…)` of a chain is its last one: the chain's parent is no `.onRoute(…)`
    const isChained =
      !ts.isSourceFile(node) &&
      ts.isPropertyAccessExpression(node.parent) &&
      node.parent.name.text === "onRoute" &&
      node.parent.expression === node;
    if (isOnRoute(node) && !isChained) {
      const { routes, receiver } = chainOf(node);
      const router = routerOf(receiver);
      if (router !== undefined) calls.push({ router, routes, last: node });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

const TARGET_CALLS = [
  "toAgent",
  "toAction",
  "toRouter",
  "toFinish",
  "toWorkflow",
  "toExternalTask",
];

/** The target of an `.onRoute(toAgent(X)…)` side path, `X`: the call its chain starts with. */
const routeTargetOf = (path: ts.Expression): string | undefined => {
  let node: ts.Expression = path;
  for (;;) {
    if (!ts.isCallExpression(node)) return undefined;
    if (ts.isPropertyAccessExpression(node.expression)) {
      node = node.expression.expression;
      continue;
    }
    return TARGET_CALLS.some((name) => isCallOf(node as ts.CallExpression, name))
      ? firstIdentifier(node)
      : undefined;
  }
};

/** The targets a router's `.onRoute(…)`s list. */
export const routeTargets = (call: FlowCall): string[] =>
  call.routes.flatMap((path) => routeTargetOf(path) ?? []);

/** The router's choice in the flow; undefined when the flow has none for it. */
export const starCalls = (calls: readonly FlowCall[], router: string): FlowCall | undefined =>
  calls.find((call) => call.router === router);

/** Where a new `.onRoute(…)` starts (#289, one call per line): the indentation of the last one. */
function routeIndent(content: string, last: ts.CallExpression): string {
  const access = last.expression;
  const start = ts.isPropertyAccessExpression(access) ? access.name.getStart() : last.getStart();
  const line = content.slice(content.lastIndexOf("\n", start - 1) + 1, start);
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/**
 * Puts a new agent into the router's choice: `.onRoute(toAgent(Agent).toFinish(Finish))` after its last
 * route. The router's `@Router({ routes })` gets the same target, wired in the router file. An agent
 * already there is skipped (reported, never doubled); an unexpected shape → an error naming the
 * file — never a guess.
 */
export function addAgentToFlow(
  file: FileToWrite,
  agent: string,
  router: string,
  finish: string,
): FileToWrite {
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
  const choice = starCalls(flowCalls(source), router);
  if (choice === undefined) {
    throw new ScaffoldError(
      `${file.path}: no .toRouter(${router}).onRoute(…) in the flow — add ${agent} by hand`,
    );
  }
  if (routeTargets(choice).includes(agent)) {
    const skipped = `${file.path}: ${agent} already in ${router}'s .onRoute(…)s`;
    return { ...file, skipped: [...(file.skipped ?? []), skipped] };
  }
  const at = choice.last.getEnd();
  const indent = routeIndent(file.content, choice.last);
  const route = `\n${indent}.onRoute(toAgent(${agent})\n${indent}  .toFinish(${finish}))`;
  return {
    path: file.path,
    content: `${file.content.slice(0, at)}${route}${file.content.slice(at)}`,
    skipped: [...(file.skipped ?? [])],
  };
}

/** Wires an agent into the workflow's flow and imports it (with the `toAgent` it writes; `.toFinish(…)` is a method). */
export const wireAgentIntoFlow = (
  file: FileToWrite,
  agent: { readonly className: string; readonly from: string },
  router: string,
  finish: string,
): FileToWrite => {
  const flowed = addAgentToFlow(file, agent.className, router, finish);
  const imported = addImport(flowed.content, file.path, agent.className, agent.from);
  return { ...flowed, content: addImport(imported, file.path, "toAgent", "@agboss/core") };
};
