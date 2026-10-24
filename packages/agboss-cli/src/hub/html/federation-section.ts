import { element, type HtmlElement } from "../../eval/html/html.js";
import { sectionOf } from "../../eval/html/sections.js";
import type { DeclaredEdge, FederationView, UnstableReach } from "../federation-view.js";

/**
 * Blast Radius & Federation (#401 PR 7): the contracts the snapshots declare, consumer → producer;
 * the problems `agboss check --federation` reports on them (the same function), each with the
 * consumer's workflows and tools it breaks; and who calls an application whose latest eval run lost
 * pass^k — by a declared contract or a call the records saw.
 */

const head = (cells: readonly string[]): HtmlElement =>
  element("thead", {}, [
    element(
      "tr",
      {},
      cells.map((cell) => element("th", { scope: "col" }, [cell])),
    ),
  ]);

const tableOf = (caption: string, cells: readonly string[], rows: HtmlElement[]): HtmlElement =>
  element("div", { class: "table-scroll" }, [
    element("table", {}, [
      element("caption", {}, [caption]),
      head(cells),
      element("tbody", {}, rows),
    ]),
  ]);

function stateOf(edge: DeclaredEdge): string {
  if (edge.problems.length > 0) return edge.problems.join(", ");
  return edge.isDangling ? "producer not among the inputs" : "compatible";
}

const declaredRow = (edge: DeclaredEdge): HtmlElement =>
  element("tr", edge.problems.length > 0 ? { class: "federation-broken" } : {}, [
    element("td", {}, [edge.from]),
    element("td", {}, [edge.to]),
    element("td", {}, [edge.kind]),
    element("td", {}, [element("code", {}, [edge.contract])]),
    element("td", {}, [edge.target]),
    element("td", {}, [edge.usedBy.map((use) => `${use.workflow} · ${use.tool}`).join(", ")]),
    element("td", {}, [stateOf(edge)]),
  ]);

function problemsOf(view: FederationView): HtmlElement {
  if (view.problems.length === 0)
    return element("p", { class: "muted" }, [
      "agboss check --federation finds no problem between these snapshots.",
    ]);
  return element(
    "ul",
    { class: "federation-problems" },
    view.problems.map((problem) =>
      element("li", {}, [
        element("p", {}, [
          element("code", {}, [`[${problem.code}]`]),
          ` ${problem.consumer} → ${problem.producer}: ${problem.message}`,
        ]),
        problem.blastRadius.length === 0
          ? undefined
          : element("p", { class: "muted" }, [
              "blast radius: ",
              problem.blastRadius
                .map((entry) => `${entry.application} › ${entry.workflow} · ${entry.tool}`)
                .join(", "),
            ]),
      ]),
    ),
  );
}

const reachRow = (reach: UnstableReach): HtmlElement =>
  element("tr", {}, [
    element("td", {}, [reach.application]),
    element("td", {}, [reach.suites.join(", ")]),
    element("td", {}, [
      reach.consumers.length === 0
        ? "no known caller"
        : reach.consumers
            .map(
              (consumer) =>
                `${consumer.application} (${consumer.via}: ${consumer.workflows.join(", ")})`,
            )
            .join("; "),
    ]),
  ]);

/** The section. */
export function federationSectionOf(view: FederationView): HtmlElement {
  return sectionOf("federation", "Blast radius & federation", [
    view.declaredEdges.length === 0
      ? element("p", { class: "muted" }, [
          "No snapshot declares a contract with another application.",
        ])
      : tableOf(
          "Contracts the snapshots declare, consumer → producer",
          ["consumer", "producer", "kind", "contract", "target", "used by", "state"],
          view.declaredEdges.map(declaredRow),
        ),
    problemsOf(view),
    view.undeclared.length === 0
      ? undefined
      : element("p", { class: "muted" }, [
          `No declared contracts read from: ${view.undeclared.join(", ")} (an older describe).`,
        ]),
    view.unstableReach.length === 0
      ? undefined
      : tableOf(
          "Applications whose latest eval run lost pass^k, and who calls them",
          ["application", "failing suites", "callers"],
          view.unstableReach.map(reachRow),
        ),
  ]);
}
