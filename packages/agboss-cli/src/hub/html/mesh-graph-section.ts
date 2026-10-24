import { element, type HtmlElement } from "../../eval/html/html.js";
import { sectionOf } from "../../eval/html/sections.js";
import type { HubMesh, MeshApplication } from "../mesh.js";
import type { DeclaredEdge } from "../federation-view.js";
import type { ObservedEdge } from "../observed-calls.js";
import { applicationAnchor } from "./anchors.js";

/**
 * The Global Agent Mesh Graph (#401 PR 3): every application as a box on an ellipse, in name order —
 * the same input gives the same drawing —, each a link to its card; an arrow per observed edge,
 * labelled with its calls. A described application has a solid border, one only seen in records or
 * runs a dashed one. A contract a snapshot declares and no record shows is a dashed arrow (#401 PR
 * 7), one `check --federation` finds broken is drawn in the failure colour. The edges table below
 * and the federation section say the same in text.
 */

const WIDTH = 760;
const HEIGHT = 440;
const NODE_WIDTH = 170;
const NODE_HEIGHT = 46;

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Where the i-th of n boxes sits: one in the middle, else on the ellipse from the top. */
export function nodeCentre(index: number, count: number): Point {
  if (count === 1) return { x: WIDTH / 2, y: HEIGHT / 2 };
  const angle = -Math.PI / 2 + (2 * Math.PI * index) / count;
  return {
    x: Math.round(WIDTH / 2 + (WIDTH / 2 - NODE_WIDTH / 2 - 12) * Math.cos(angle)),
    y: Math.round(HEIGHT / 2 + (HEIGHT / 2 - NODE_HEIGHT / 2 - 12) * Math.sin(angle)),
  };
}

/** The point where the line from a box's centre towards `to` leaves the box. */
function boxEdge(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const scale = Math.min(
    dx === 0 ? Infinity : NODE_WIDTH / 2 / Math.abs(dx),
    dy === 0 ? Infinity : NODE_HEIGHT / 2 / Math.abs(dy),
  );
  return { x: Math.round(from.x + dx * scale), y: Math.round(from.y + dy * scale) };
}

const shortName = (name: string): string => (name.length > 24 ? `${name.slice(0, 23)}…` : name);

function nodeOf(application: MeshApplication, index: number, centre: Point): HtmlElement {
  const note =
    application.file === undefined
      ? "not described"
      : `${String(application.workflows.length)} workflows`;
  return element(
    "a",
    {
      href: `#${applicationAnchor(index)}`,
      class: application.file === undefined ? "mesh-node mesh-undescribed" : "mesh-node",
    },
    [
      element("title", {}, [application.name]),
      element("rect", {
        x: centre.x - NODE_WIDTH / 2,
        y: centre.y - NODE_HEIGHT / 2,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        rx: 8,
      }),
      element("text", { x: centre.x, y: centre.y - 3, "text-anchor": "middle" }, [
        shortName(application.name),
      ]),
      element(
        "text",
        { x: centre.x, y: centre.y + 14, "text-anchor": "middle", class: "mesh-node-note" },
        [note],
      ),
    ],
  );
}

/** One arrow between two applications: what was observed and what is declared. */
interface DrawnEdge {
  readonly from: string;
  readonly to: string;
  readonly calls: number;
  readonly isDeclared: boolean;
  readonly isBroken: boolean;
}

function drawnEdgesOf(
  observed: readonly ObservedEdge[],
  declared: readonly DeclaredEdge[],
): DrawnEdge[] {
  const drawn = new Map<string, DrawnEdge>();
  const keyOf = (from: string, to: string): string => JSON.stringify([from, to]);
  for (const edge of observed)
    drawn.set(keyOf(edge.from, edge.to), {
      from: edge.from,
      to: edge.to,
      calls: edge.calls,
      isDeclared: false,
      isBroken: false,
    });
  for (const edge of declared) {
    const key = keyOf(edge.from, edge.to);
    const known = drawn.get(key);
    drawn.set(key, {
      from: edge.from,
      to: edge.to,
      calls: known?.calls ?? 0,
      isDeclared: true,
      isBroken: (known?.isBroken ?? false) || edge.problems.length > 0,
    });
  }
  return [...drawn.values()];
}

function labelOf(edge: DrawnEdge): string {
  const calls =
    edge.calls === 0 ? "declared" : `${String(edge.calls)} call${edge.calls === 1 ? "" : "s"}`;
  if (edge.isBroken) return `${calls} · incompatible`;
  return edge.calls > 0 && edge.isDeclared ? `${calls} · declared` : calls;
}

function classOf(edge: DrawnEdge): string {
  const classes = ["mesh-edge"];
  if (edge.calls === 0) classes.push("mesh-edge-declared");
  if (edge.isBroken) classes.push("mesh-edge-broken");
  return classes.join(" ");
}

function edgeOf(edge: DrawnEdge, centres: ReadonlyMap<string, Point>): HtmlElement[] {
  const from = centres.get(edge.from);
  const to = centres.get(edge.to);
  if (from === undefined || to === undefined || edge.from === edge.to) return [];
  const start = boxEdge(from, to);
  const end = boxEdge(to, from);
  return [
    element("line", {
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      class: classOf(edge),
      "marker-end": "url(#mesh-arrow)",
    }),
    element(
      "text",
      {
        x: Math.round((start.x + end.x) / 2),
        y: Math.round((start.y + end.y) / 2) - 6,
        "text-anchor": "middle",
        class: edge.isBroken ? "mesh-edge-label mesh-edge-broken" : "mesh-edge-label",
      },
      [labelOf(edge)],
    ),
  ];
}

const ARROW = element("defs", {}, [
  element(
    "marker",
    {
      id: "mesh-arrow",
      viewBox: "0 0 10 10",
      refX: 9,
      refY: 5,
      markerWidth: 8,
      markerHeight: 8,
      orient: "auto-start-reverse",
    },
    [element("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "mesh-arrow" })],
  ),
]);

/** The graph's section. */
export function meshGraphSectionOf(mesh: HubMesh): HtmlElement {
  const count = mesh.applications.length;
  const edges = drawnEdgesOf(mesh.edges, mesh.federation.declaredEdges);
  const centres = new Map(
    mesh.applications.map((application, index) => [application.name, nodeCentre(index, count)]),
  );
  const svg = element(
    "svg",
    {
      viewBox: `0 0 ${String(WIDTH)} ${String(HEIGHT)}`,
      role: "img",
      "aria-labelledby": "mesh-graph-caption",
      xmlns: "http://www.w3.org/2000/svg",
    },
    [
      element("title", { id: "mesh-graph-caption" }, [
        `${String(count)} applications, ${String(mesh.edges.length)} observed edges, ${String(mesh.federation.declaredEdges.length)} declared contracts`,
      ]),
      ARROW,
      ...edges.flatMap((edge) => edgeOf(edge, centres)),
      ...mesh.applications.map((application, index) =>
        nodeOf(application, index, centres.get(application.name) ?? nodeCentre(index, count)),
      ),
    ],
  );
  return sectionOf("mesh-graph", "Agent mesh", [
    element("p", { class: "muted" }, [
      "Applications and the calls between them the records saw. A dashed box is an application no snapshot describes; a dashed arrow a contract a snapshot declares that no record shows; a red one a contract check --federation finds incompatible.",
    ]),
    element("div", { class: "mesh-graph" }, [svg]),
  ]);
}
