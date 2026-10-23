import { element, type HtmlElement } from "../../eval/html/html.js";
import { shareText, usdText } from "../../eval/html/format.js";
import type { RecordsHealth, SuiteHealth } from "../derived-health.js";
import type { MeshApplication } from "../mesh.js";

/**
 * An application's health on its card (#401 PR 3, S2 Q5): tiles from its kept executions — how many,
 * the failure rate, p95 duration, spend —, the `limit.*` / `mesh.*` codes they failed with, spend per
 * day, and the latest run of each eval suite (pass^k). Nothing live: what its files say.
 */

/** `850 ms`, `12.4 s`, `3.1 min`. */
export function millisecondsText(ms: number): string {
  if (ms < 1000) return `${String(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

const tileOf = (label: string, value: string, note?: string): HtmlElement =>
  element("li", { class: "tile" }, [
    element("span", { class: "tile-label" }, [label]),
    element("span", { class: "tile-value" }, [value]),
    note === undefined ? undefined : element("span", { class: "tile-note" }, [note]),
  ]);

const tableOf = (caption: string, head: readonly string[], rows: readonly (readonly string[])[]) =>
  element("div", { class: "table-scroll" }, [
    element("table", {}, [
      element("caption", {}, [caption]),
      element("thead", {}, [
        element(
          "tr",
          {},
          head.map((cell) => element("th", { scope: "col" }, [cell])),
        ),
      ]),
      element(
        "tbody",
        {},
        rows.map((row) =>
          element(
            "tr",
            {},
            row.map((cell) => element("td", {}, [cell])),
          ),
        ),
      ),
    ]),
  ]);

function recordsViewOf(health: RecordsHealth): HtmlElement[] {
  const codes = Object.entries(health.errorCodes).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return [
    element("ul", { class: "tiles" }, [
      tileOf("executions", String(health.executions), `${String(health.paused)} paused`),
      tileOf(
        "failure rate",
        `${String(Math.round(health.failureRate * 100))}%`,
        `${String(health.failed)} failed, ${String(health.cancelled)} cancelled`,
      ),
      tileOf(
        "p95 duration",
        health.p95DurationMs === undefined ? "—" : millisecondsText(health.p95DurationMs),
      ),
      tileOf("spend", usdText(health.spendUsd)),
    ]),
    codes.length === 0
      ? element("p", { class: "muted" }, ["No limit.* or mesh.* failures."])
      : tableOf(
          "Limit and mesh failures",
          ["code", "executions"],
          codes.map(([code, count]) => [code, String(count)]),
        ),
    tableOf(
      "Spend per day (UTC)",
      ["day", "spend"],
      health.spendByDay.map(({ day, usd }) => [day, usdText(usd)]),
    ),
  ];
}

const suiteRow = (suite: SuiteHealth): readonly string[] => [
  suite.suite,
  suite.workflow,
  shareText(suite.passHatK, suite.cases),
  shareText(suite.passAtK, suite.cases),
  String(suite.unstable),
  String(suite.runs),
  suite.endedAt,
];

/** The health parts of a card: nothing for an application without records or runs. */
export function healthOf(application: MeshApplication): HtmlElement[] {
  const records = application.records === undefined ? [] : recordsViewOf(application.records);
  const suites =
    application.suites.length === 0
      ? []
      : [
          tableOf(
            "Latest eval run of each suite",
            ["suite", "workflow", "pass^k", "pass@k", "unstable", "runs", "ended"],
            application.suites.map(suiteRow),
          ),
        ];
  return [...records, ...suites];
}
