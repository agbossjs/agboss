import { htmlDocumentOf } from "../../eval/html/document.js";
import { durationText, usdText } from "../../eval/html/format.js";
import { element, renderHtml, type HtmlElement } from "../../eval/html/html.js";
import { sectionOf } from "../../eval/html/sections.js";
import { HUB_PAGE_STYLE } from "../html/hub-style.js";
import type { RecordPage } from "./record-search.js";

/**
 * `agboss hub ui`'s records page (#401 PR 6): the search form (a GET to this page, the token in a
 * hidden field — the CSP allows forms to `'self'` only), the matching executions a page at a time,
 * and links to the next and previous pages.
 */

const FIELDS: readonly (readonly [string, string])[] = [
  ["q", "text in an id, workflow or application"],
  ["application", "application"],
  ["workflow", "workflow"],
  ["status", "status (finished, failed, cancelled, paused)"],
  ["from", "started from (ISO 8601)"],
  ["to", "started before (ISO 8601)"],
];

function formOf(params: URLSearchParams, token: string): HtmlElement {
  return element("form", { method: "get", action: "/records", class: "label-form" }, [
    element("input", { type: "hidden", name: "token", value: token }),
    ...FIELDS.map(([name, label]) =>
      element("label", {}, [
        label,
        element("input", { type: "text", name, value: params.get(name) ?? "" }),
      ]),
    ),
    element("button", { type: "submit" }, ["Search"]),
  ]);
}

function linkTo(params: URLSearchParams, offset: number, label: string): HtmlElement {
  const next = new URLSearchParams(params);
  next.set("offset", String(offset));
  return element("a", { href: `/records?${next.toString()}` }, [label]);
}

function pagingOf(page: RecordPage, params: URLSearchParams, token: string): HtmlElement {
  const kept = new URLSearchParams(params);
  kept.set("token", token);
  const previous =
    page.offset > 0 ? linkTo(kept, Math.max(page.offset - page.limit, 0), "← previous") : undefined;
  const after = page.offset + page.limit;
  const next = after < page.total ? linkTo(kept, after, "next →") : undefined;
  const shown =
    page.records.length === 0
      ? "none"
      : `${String(page.offset + 1)}–${String(page.offset + page.records.length)}`;
  return element("p", {}, [`${shown} of ${String(page.total)} `, previous, " ", next]);
}

const rowOf = (record: RecordPage["records"][number]): HtmlElement =>
  element("tr", {}, [
    element("td", {}, [record.application]),
    element("td", {}, [record.workflow]),
    element("td", {}, [element("code", {}, [record.executionId])]),
    element("td", {}, [record.status]),
    element("td", {}, [record.startedAt]),
    element("td", {}, [
      record.endedAt === undefined ? "" : durationText(record.startedAt, record.endedAt),
    ]),
    element("td", { class: "number" }, [usdText(record.spendUsd)]),
    element("td", {}, [record.file]),
  ]);

/** The records page. */
export function recordsPageOf(page: RecordPage, params: URLSearchParams, token: string): string {
  const head = [
    "application",
    "workflow",
    "execution",
    "status",
    "started",
    "duration",
    "spend",
    "file",
  ];
  const body = renderHtml(
    element("main", {}, [
      element("p", {}, [element("a", { href: `/?token=${token}` }, ["← The mesh"])]),
      sectionOf("records", "Kept executions", [
        formOf(params, token),
        pagingOf(page, params, token),
        element("div", { class: "table-scroll" }, [
          element("table", {}, [
            element("thead", {}, [
              element(
                "tr",
                {},
                head.map((cell) => element("th", { scope: "col" }, [cell])),
              ),
            ]),
            element("tbody", {}, page.records.map(rowOf)),
          ]),
        ]),
      ]),
    ]),
  );
  return htmlDocumentOf("Kept executions — agboss hub", body, {
    style: HUB_PAGE_STYLE,
    generator: "agboss hub",
    isPostingForms: true,
  });
}
