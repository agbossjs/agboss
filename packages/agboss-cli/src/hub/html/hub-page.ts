import { htmlDocumentOf } from "../../eval/html/document.js";
import { element, renderHtml, type HtmlElement } from "../../eval/html/html.js";
import { factsOf, sectionOf } from "../../eval/html/sections.js";
import type { HubMesh } from "../mesh.js";
import { applicationsSectionOf } from "./applications-section.js";
import { HUB_PAGE_STYLE } from "./hub-style.js";
import { meshGraphSectionOf } from "./mesh-graph-section.js";

/**
 * The Hub's page (#401 PR 3): one self-contained document in #397's shell — inline style and
 * script allowed by their hashes, no request of any kind, so it reads from `file://` or behind a
 * company's own SSO — with the mesh graph, the observed edges and every application's card.
 */

function headerOf(mesh: HubMesh): HtmlElement {
  const workflows = mesh.applications.reduce(
    (total, application) => total + application.workflows.length,
    0,
  );
  return element("header", { class: "report-header" }, [
    element("p", { class: "eyebrow" }, ["agboss hub"]),
    element("h1", {}, ["Agent mesh"]),
    factsOf([
      ["applications", String(mesh.applications.length)],
      ["workflows", String(workflows)],
      ["observed edges", String(mesh.edges.length)],
      ["snapshots", String(mesh.inputs.describe)],
      ["eval runs", String(mesh.inputs.evalRuns)],
      ["kept executions", String(mesh.inputs.records)],
    ]),
  ]);
}

function edgesSectionOf(mesh: HubMesh): HtmlElement {
  if (mesh.edges.length === 0)
    return sectionOf("edges", "Observed edges", [
      element("p", { class: "muted" }, ["No call between applications in the records."]),
    ]);
  const rows = mesh.edges.map((edge) =>
    element("tr", {}, [
      element("td", {}, [edge.from]),
      element("td", {}, [edge.to]),
      element("td", { class: "number" }, [String(edge.calls)]),
      element("td", {}, [edge.workflows.join(", ")]),
      element("td", {}, [edge.tools.join(", ")]),
    ]),
  );
  return sectionOf("edges", "Observed edges", [
    element("div", { class: "table-scroll" }, [
      element("table", {}, [
        element("caption", {}, ["Calls from one application to another, each counted once"]),
        element("thead", {}, [
          element(
            "tr",
            {},
            ["from", "to", "calls", "calling workflows", "tools"].map((cell) =>
              element("th", { scope: "col" }, [cell]),
            ),
          ),
        ]),
        element("tbody", {}, rows),
      ]),
    ]),
  ]);
}

/** The whole page. */
export function renderHubPage(mesh: HubMesh): string {
  const body = [
    renderHtml(headerOf(mesh)),
    renderHtml(
      element("main", {}, [
        meshGraphSectionOf(mesh),
        edgesSectionOf(mesh),
        applicationsSectionOf(mesh.applications),
      ]),
    ),
    renderHtml(
      element("footer", {}, [
        "Made by agboss hub from snapshots, eval runs and kept executions — nothing live.",
      ]),
    ),
  ].join("");
  return htmlDocumentOf("Agent mesh — agboss hub", body, {
    style: HUB_PAGE_STYLE,
    generator: "agboss hub",
  });
}
