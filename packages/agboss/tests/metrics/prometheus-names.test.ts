/**
 * #943 AC2 (G6, #889): the names a Prometheus scrape shows are the catalog's under the exporter's
 * rules — dots become underscores, a UCUM unit that is not an annotation is appended (`s` →
 * `_seconds`), a counter gets `_total`, a histogram `_bucket` / `_sum` / `_count` — and no name
 * carries its unit itself.
 */
import { describe, expect, it } from "vitest";
import { METRICS, MetricKind, type MetricSpec } from "../../src/metrics/metric-catalog.js";

const UNIT_WORD: Readonly<Record<string, string>> = { s: "seconds" };

/** The series a Prometheus exporter writes for a metric. */
function seriesOf(spec: MetricSpec): readonly string[] {
  const base = spec.name.replaceAll(".", "_");
  const unit = UNIT_WORD[spec.unit];
  const named = unit === undefined ? base : `${base}_${unit}`;
  if (spec.kind === MetricKind.Counter) return [`${named}_total`];
  if (spec.kind === MetricKind.Histogram)
    return [`${named}_bucket`, `${named}_sum`, `${named}_count`];
  return [named];
}

describe("#943 AC2: Prometheus names", () => {
  it("the pause metrics read as the dashboards expect", () => {
    expect(seriesOf(METRICS.pausesTimeToAnswer)).toEqual([
      "agboss_instance_pauses_time_to_answer_seconds_bucket",
      "agboss_instance_pauses_time_to_answer_seconds_sum",
      "agboss_instance_pauses_time_to_answer_seconds_count",
    ]);
    expect(
      [
        METRICS.pausesOpened,
        METRICS.pausesClosed,
        METRICS.pausesExtended,
        METRICS.pausesAnswersNotTaken,
        METRICS.noticesWaiting,
        METRICS.noticesDead,
      ].flatMap(seriesOf),
    ).toEqual([
      "agboss_instance_pauses_opened_total",
      "agboss_instance_pauses_closed_total",
      "agboss_instance_pauses_extended_total",
      "agboss_instance_pauses_answers_not_taken_total",
      "agboss_cluster_pauses_notices_waiting",
      "agboss_cluster_pauses_notices_dead",
    ]);
  });

  it("no metric name carries a unit, and no two metrics share a series", () => {
    const names = Object.values(METRICS).map((spec) => spec.name);
    for (const name of names) expect(name).not.toMatch(/(_|\.)(seconds|ms|bytes|count|total)$/);
    const series = Object.values(METRICS).flatMap(seriesOf);
    expect(new Set(series).size).toBe(series.length);
  });
});
