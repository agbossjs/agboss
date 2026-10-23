import { element, type HtmlElement } from "../../eval/html/html.js";
import { sectionOf } from "../../eval/html/sections.js";
import type { HubMesh, MeshApplication } from "../mesh.js";
import type { ObservedEdge } from "../observed-calls.js";
import { applicationAnchor } from "./anchors.js";

/**
 * The Global Agent Mesh Graph (#401 PR 3): every application as a box on an ellipse, in name order —
 * the same input gives the same drawing —, each a link to its card; an arrow per observed edge,
 * labelled with its calls. A described application has a solid border, one only seen in records or
 * runs a dashed one. The edges table below says the same in text.
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

function edgeOf(edge: ObservedEdge, centres: ReadonlyMap<string, Point>): HtmlElement[] {
  const from = centres.get(edge.from);
  const to = centres.get(edge.to);
  if (from === undefined || to === undefined || edge.from === edge.to) return [];
  const start = boxEdge(from, to);
  const end = boxEdge(to, from);
  const label = `${String(edge.calls)} call${edge.calls === 1 ? "" : "s"}`;
  return [
    element("line", {
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      class: "mesh-edge",
      "marker-end": "url(#mesh-arrow)",
    }),
    element(
      "text",
      {
        x: Math.round((start.x + end.x) / 2),
        y: Math.round((start.y + end.y) / 2) - 6,
        "text-anchor": "middle",
        class: "mesh-edge-label",
      },
      [label],
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
        `${String(count)} applications, ${String(mesh.edges.length)} observed edges`,
      ]),
      ARROW,
      ...mesh.edges.flatMap((edge) => edgeOf(edge, centres)),
      ...mesh.applications.map((application, index) =>
        nodeOf(application, index, centres.get(application.name) ?? nodeCentre(index, count)),
      ),
    ],
  );
  return sectionOf("mesh-graph", "Agent mesh", [
    element("p", { class: "muted" }, [
      "Applications and the calls between them the records saw. A dashed box is an application no snapshot describes.",
    ]),
    element("div", { class: "mesh-graph" }, [svg]),
  ]);
}
