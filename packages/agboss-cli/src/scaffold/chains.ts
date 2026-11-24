import ts from "typescript";

/**
 * One call per line in a workflow module's chains (#289): `onStart(A).returns(B).toFinish(C)` is
 * written `onStart(A)` / `.returns(B)` / `.toFinish(C)`, as `@stylistic/newline-per-chained-call`
 * (`ignoreChainWithDepth: 1`) wants. Prettier joins a short chain onto one line unless the chain
 * holds a comment, so every chained call gets a marker line comment after its object before
 * Prettier runs (a trailing line comment does not count in its line width), removed afterwards.
 */
const MARK = "//@@one-call-per-line@@\n";
const MARKS = /[ \t]*\/\/@@one-call-per-line@@[ \t]*$/gm;

/** The files the rule covers among the generated ones. */
export const isFlowFile = (path: string): boolean => path.endsWith(".workflow.ts");

const isMember = (
  node: ts.Node,
): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
  ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);

/** How deep a call on `member` is in its chain, counted as the stylistic rule counts it. */
function depthOf(member: ts.PropertyAccessExpression | ts.ElementAccessExpression): number {
  let parent: ts.Expression = member.expression;
  let depth = 1;
  while (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    depth += 1;
    if (!isMember(parent.expression)) break;
    parent = parent.expression.expression;
  }
  return depth;
}

/**
 * The gaps of every chained call of `text`: from the end of its object (and of any comment after
 * it) to its `.`.
 */
function chainGaps(text: string, path: string): (readonly [number, number])[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const gaps: (readonly [number, number])[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isMember(node.expression) && depthOf(node.expression) > 1) {
      const dot = node.expression.getChildren(source)[1]?.getStart(source);
      if (dot !== undefined) gaps.push([text.slice(0, dot).trimEnd().length, dot]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return gaps;
}

/** `text` with a marker ending the line after the object of every chained call. */
export function markChains(text: string, path: string): string {
  let marked = text;
  // the blanks before the `.` go, so no blank line stays; a line comment there keeps the marker
  for (const [end, dot] of chainGaps(text, path).sort(([a], [b]) => b - a))
    marked = `${marked.slice(0, end)}${MARK}${marked.slice(dot)}`;
  return marked;
}

/** The markers taken out of formatted text. */
export const unmarkChains = (text: string): string =>
  text.replace(MARKS, "").replace(/[ \t]+$/gm, "");
