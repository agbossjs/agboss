import { element, type HtmlChild, type HtmlElement } from "../../eval/html/html.js";
import { durationText, usdText } from "../../eval/html/format.js";
import { sectionOf } from "../../eval/html/sections.js";
import type { ExecutionTree, TreeCall, TreeExecution } from "../execution-trees.js";

/**
 * The Cross-Service Execution Trees (#401 PR 4): each tree that crosses applications, from its
 * root — every execution with its application, workflow, status, duration and spend; under it the
 * calls that ran a remote execution, each with the execution it ran (or a stub when its receiver
 * did not export its record), and its in-process child executions that called out.
 */

/** The anchor of a tree, by its root execution's id (`#tree-<id>`, the `hub ui` link too). */
export const treeAnchor = (tree: ExecutionTree): string => `tree-${tree.root.executionId}`;

function headOf(execution: TreeExecution): HtmlChild[] {
  const duration =
    execution.startedAt === undefined || execution.endedAt === undefined
      ? ""
      : durationText(execution.startedAt, execution.endedAt);
  return [
    element("strong", {}, [execution.application]),
    " · ",
    element("code", {}, [execution.workflow]),
    " ",
    element(
      "span",
      { class: `status status-${execution.status === "finished" ? "passed" : "failed"}` },
      [execution.status],
    ),
    element("span", { class: "muted" }, [
      ` ${execution.executionId}${duration === "" ? "" : ` · ${duration}`} · ${usdText(execution.spendUsd)}`,
    ]),
  ];
}

function callOf(call: TreeCall): HtmlElement {
  const target =
    call.target.kind === "stub"
      ? element("li", { class: "tree-stub" }, [
          `${call.target.application} · ${call.target.executionId} (not exported)`,
        ])
      : executionOf(call.target);
  return element("li", { class: "tree-call" }, [
    element("p", { class: "tree-call-head" }, [
      "→ ",
      element("code", {}, [call.tool]),
      ` (${call.status})`,
    ]),
    element("ul", { class: "tree" }, [target]),
  ]);
}

function executionOf(execution: TreeExecution): HtmlElement {
  return element("li", { class: "tree-execution" }, [
    element("p", { class: "tree-execution-head" }, headOf(execution)),
    execution.calls.length + execution.children.length === 0
      ? undefined
      : element("ul", { class: "tree" }, [
          ...execution.calls.map(callOf),
          ...execution.children.map((child) =>
            element("li", { class: "tree-child" }, [
              element("p", { class: "muted" }, ["child execution"]),
              element("ul", { class: "tree" }, [executionOf(child)]),
            ]),
          ),
        ]),
  ]);
}

function treeOf(tree: ExecutionTree): HtmlElement {
  const calledBy =
    tree.calledBy === undefined
      ? undefined
      : element("p", { class: "tree-stub" }, [
          `called by ${tree.calledBy.application} · ${tree.calledBy.executionId}, whose call is not in the exports`,
        ]);
  return element("li", {}, [
    element("details", { class: "tree-root", id: treeAnchor(tree) }, [
      element("summary", {}, [
        element("strong", {}, [tree.applications.join(" → ")]),
        element("span", { class: "muted" }, [
          ` · ${String(tree.executions)} executions${tree.stubs === 0 ? "" : ` · ${String(tree.stubs)} not exported`} · root ${tree.root.executionId}`,
        ]),
      ]),
      calledBy,
      element("ul", { class: "tree" }, [executionOf(tree.root)]),
    ]),
  ]);
}

/** The trees' section. */
export function treesSectionOf(trees: readonly ExecutionTree[]): HtmlElement {
  if (trees.length === 0)
    return sectionOf("trees", "Execution trees across applications", [
      element("p", { class: "muted" }, ["No execution in the records called another application."]),
    ]);
  return sectionOf("trees", "Execution trees across applications", [
    element("p", { class: "muted" }, [
      "Stitched from the exports by each receiver's origin: the calling execution and its call's idempotency key.",
    ]),
    element("ul", { class: "trees" }, trees.map(treeOf)),
  ]);
}
