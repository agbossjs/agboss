import ts from "typescript";
import { ScaffoldError } from "./errors.js";
import { addImport } from "./wire.js";
import type { FileToWrite } from "./write.js";

/**
 * A router's choice in the flow (#272): `….toRouter(R).chooseOne(route(A)…, …)` or
 * `onRouter(R).chooseOne(…)` — the router and the `route(…)` paths it lists.
 */
export interface FlowCall {
  readonly router: string;
  readonly routes: ts.NodeArray<ts.Expression>;
}

const isCallOf = (node: ts.CallExpression, name: string): boolean =>
  (ts.isIdentifier(node.expression) && node.expression.text === name) ||
  (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === name);

const firstIdentifier = (call: ts.CallExpression): string | undefined => {
  const [first] = call.arguments;
  return first !== undefined && ts.isIdentifier(first) ? first.text : undefined;
};

/** The router a `.chooseOne(…)` belongs to: the `toRouter(R)` / `onRouter(R)` it is called on. */
function routerOf(receiver: ts.Expression): string | undefined {
  if (!ts.isCallExpression(receiver)) return undefined;
  return isCallOf(receiver, "toRouter") || isCallOf(receiver, "onRouter")
    ? firstIdentifier(receiver)
    : undefined;
}

export function flowCalls(source: ts.SourceFile): FlowCall[] {
  const calls: FlowCall[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "chooseOne"
    ) {
      const router = routerOf(node.expression.expression);
      if (router !== undefined) calls.push({ router, routes: node.arguments });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

/** The target of a `route(X)…` path, `X`. */
const routeTargetOf = (path: ts.Expression): string | undefined => {
  let node: ts.Expression = path;
  while (ts.isCallExpression(node)) {
    if (isCallOf(node, "route")) return firstIdentifier(node);
    if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
    node = node.expression.expression;
  }
  return undefined;
};

/** The targets a router's `chooseOne` lists. */
export const routeTargets = (call: FlowCall): string[] =>
  call.routes.flatMap((path) => routeTargetOf(path) ?? []);

/** The router's choice in the flow; undefined when the flow has none for it. */
export const starCalls = (calls: readonly FlowCall[], router: string): FlowCall | undefined =>
  calls.find((call) => call.router === router);

/** Where a new route starts (#289, one call per line): under the last one, or a step further in. */
function routeIndent(content: string, start: number): string {
  const line = content.slice(content.lastIndexOf("\n", start - 1) + 1, start);
  const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
  return line.trim() === "" ? indent : `${indent}  `;
}

/**
 * Puts a new agent into the router's choice: `route(Agent).toFinish(Finish)` after its last route.
 * The router's `@Router({ routes })` gets the same target, wired in the router file. An agent
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
  const last = choice?.routes.at(-1);
  if (choice === undefined || last === undefined) {
    throw new ScaffoldError(
      `${file.path}: no .toRouter(${router}).chooseOne(route(…)…) in the flow — add ${agent} by hand`,
    );
  }
  if (routeTargets(choice).includes(agent)) {
    const skipped = `${file.path}: ${agent} already in ${router}'s chooseOne(…)`;
    return { ...file, skipped: [...(file.skipped ?? []), skipped] };
  }
  const at = last.getEnd();
  const indent = routeIndent(file.content, last.getStart());
  const route = `,\n${indent}route(${agent})\n${indent}  .toFinish(${finish})`;
  return {
    path: file.path,
    content: `${file.content.slice(0, at)}${route}${file.content.slice(at)}`,
    skipped: [...(file.skipped ?? [])],
  };
}

/** Wires an agent into the workflow's flow and imports it. */
export const wireAgentIntoFlow = (
  file: FileToWrite,
  agent: { readonly className: string; readonly from: string },
  router: string,
  finish: string,
): FileToWrite => {
  const flowed = addAgentToFlow(file, agent.className, router, finish);
  return {
    ...flowed,
    content: addImport(flowed.content, file.path, agent.className, agent.from),
  };
};
