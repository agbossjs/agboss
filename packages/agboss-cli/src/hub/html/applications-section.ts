import { element, type HtmlChild, type HtmlElement } from "../../eval/html/html.js";
import { factsOf, sectionOf } from "../../eval/html/sections.js";
import type { DescribedWorkflow } from "../hub-inputs.js";
import type { MeshApplication } from "../mesh.js";
import { applicationAnchor } from "./anchors.js";
import { healthOf } from "./health-view.js";

/**
 * One card per application of the mesh (#401 PR 3): what its newest snapshot describes — each
 * workflow with its agents, routers, actions, child workflows, tools and MCP servers —, its channel
 * roles, and its health from its records and eval runs.
 */

const KINDS: readonly (readonly [string, string])[] = [
  ["agent", "agents"],
  ["router", "routers"],
  ["action", "actions"],
  ["workflow", "child workflows"],
];

/** `agents: a, b` — a part list, left out when empty. */
function partsRow(label: string, names: readonly string[]): HtmlElement | undefined {
  if (names.length === 0) return undefined;
  return element("li", {}, [`${label}: `, element("code", {}, [names.join(", ")])]);
}

function workflowOf(workflow: DescribedWorkflow): HtmlElement {
  const local = workflow.tools.filter((tool) => tool.kind !== "mcp").map((tool) => tool.name);
  const servers = [
    ...new Set(workflow.tools.flatMap((tool) => (tool.server === undefined ? [] : [tool.server]))),
  ];
  const rows: HtmlChild[] = [
    ...KINDS.map(([kind, label]) =>
      partsRow(
        label,
        workflow.nodes.filter((node) => node.kind === kind).map((node) => node.name),
      ),
    ),
    partsRow("tools", local),
    partsRow("MCP servers", servers),
  ];
  return element("details", { class: "workflow" }, [
    element("summary", {}, [element("code", {}, [workflow.name]), ` ${workflow.version}`]),
    element("ul", { class: "parts" }, rows),
  ]);
}

function cardOf(application: MeshApplication, index: number): HtmlElement {
  const roles = application.channels
    .filter((channel) => channel.isRole)
    .map((channel) => channel.name);
  const isDescribed = application.file !== undefined;
  return element("li", {}, [
    element("article", { id: applicationAnchor(index), class: "application" }, [
      element("h3", {}, [application.name]),
      element("p", { class: "badges" }, [
        element("span", { class: isDescribed ? "badge badge-passed" : "badge badge-neutral" }, [
          isDescribed ? "described" : "not described",
        ]),
      ]),
      factsOf([
        ["versions", application.versions.join(", ")],
        ["snapshot", application.file ?? ""],
        ["workflows", isDescribed ? String(application.workflows.length) : ""],
        ["channel roles", roles.join(", ")],
      ]),
      ...healthOf(application),
      ...application.workflows.map(workflowOf),
    ]),
  ]);
}

/** The cards' section. */
export function applicationsSectionOf(applications: readonly MeshApplication[]): HtmlElement {
  return sectionOf("applications", "Applications", [
    element("ul", { class: "applications" }, applications.map(cardOf)),
  ]);
}
