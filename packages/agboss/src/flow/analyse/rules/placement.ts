import { ComponentKind } from "../../runtime/records.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import type { ComponentName } from "../../registry.js";
import type { FlowNode } from "../flow-graph.js";
import { classLabel, sourceCallOf, toCallOf } from "../labels.js";
import { MentionKind, type Mention } from "../walked-flow.js";
import type { AnalysisContext } from "./context.js";

/**
 * Where a node is continued (#272 AC3, AC4): reached from one place → inline, right there; from two
 * or more → in its own path, every path into it ending with `.to…(Node)`; one class is one node, so
 * it is continued once. Starts (a path of their own) and finishes (terminal) are not placed.
 */

interface NodeMentions {
  readonly entries: number;
  readonly inline: number;
  readonly ownPaths: number;
}

function countMentions(mentions: readonly Mention[]): ReadonlyMap<ComponentName, NodeMentions> {
  const byNode = new Map<ComponentName, NodeMentions>();
  for (const mention of mentions) {
    const counts = byNode.get(mention.node) ?? { entries: 0, inline: 0, ownPaths: 0 };
    const isEntry = mention.kind === MentionKind.Entry;
    byNode.set(mention.node, {
      entries: counts.entries + (isEntry ? 1 : 0),
      inline: counts.inline + (isEntry && mention.isContinued ? 1 : 0),
      ownPaths: counts.ownPaths + (isEntry ? 0 : 1),
    });
  }
  return byNode;
}

const ownPathOf = (node: FlowNode): string =>
  `${sourceCallOf(node.kind)}(${classLabel(node.component)})…`;

function placementOf(node: FlowNode, counts: NodeMentions): RuleViolation | undefined {
  const continuations = counts.inline + counts.ownPaths;
  if (continuations > 1) {
    const message =
      `${node.name} is continued in ${String(continuations)} places — one class is one node; ` +
      `make a second class (…options, name: "…")`;
    return violation("flow.continuation-twice", message, [node.name]);
  }
  if (counts.entries >= 2 && counts.inline === 1) {
    const message =
      `${node.name} is reached from ${String(counts.entries)} paths — continue it in its own ` +
      `path ${ownPathOf(node)}`;
    return violation("flow.shared-node-inline", message, [node.name]);
  }
  if (counts.entries === 1 && counts.ownPaths === 1) {
    const call = `.${toCallOf(node.kind)}(${classLabel(node.component)})`;
    const message =
      `${node.name} is reached from 1 path — continue it inline after ${call} and remove its ` +
      `own path ${ownPathOf(node)}`;
    return violation("flow.single-entry-own-path", message, [node.name]);
  }
  return undefined;
}

export function placementRules(context: AnalysisContext): readonly RuleViolation[] {
  const counts = countMentions(context.walked.mentions);
  return [...context.graph.nodes.values()].flatMap((node) => {
    if (node.kind === ComponentKind.WorkflowStart || node.kind === ComponentKind.WorkflowFinish)
      return [];
    const found = placementOf(
      node,
      counts.get(node.name) ?? { entries: 0, inline: 0, ownPaths: 0 },
    );
    return found === undefined ? [] : [found];
  });
}
