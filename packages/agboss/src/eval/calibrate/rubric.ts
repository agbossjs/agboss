import type { EvalMetricGroup, EvalMetricValue, EvalScoreCounts } from "./calibration.js";
import type { MatchedLabel } from "./verdicts.js";

/**
 * The rubric view of one judge (#396 S2 Q8, C5): over its labelled runs, each `metrics` key of its
 * verdicts with how often the judge and a labeler disagreed and agreed where the key was measured —
 * a text or flag metric by value, a numeric one by its mean on each side — and the labelers' scores
 * (1–4) on the runs the judge passed and failed.
 */

const isDisagreement = ({ label, verdict }: MatchedLabel): boolean =>
  label.passed !== verdict.passed;

const meanOf = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;

function valuesOf(measured: readonly MatchedLabel[], key: string): readonly EvalMetricValue[] {
  const counts = new Map<string, { disagreements: number; agreements: number }>();
  for (const pair of measured) {
    const value = String(pair.verdict.metrics?.[key]);
    const count = counts.get(value) ?? { disagreements: 0, agreements: 0 };
    if (isDisagreement(pair)) count.disagreements += 1;
    else count.agreements += 1;
    counts.set(value, count);
  }
  return [...counts]
    .map(([value, count]) => ({ value, ...count }))
    .sort((first, second) => second.disagreements - first.disagreements);
}

function numbersOf(pairs: readonly MatchedLabel[], key: string): number[] {
  return pairs.flatMap((pair) => {
    const value = pair.verdict.metrics?.[key];
    return typeof value === "number" ? [value] : [];
  });
}

function meanGroupOf(measured: readonly MatchedLabel[], key: string): EvalMetricGroup["mean"] {
  const onDisagreements = meanOf(numbersOf(measured.filter(isDisagreement), key));
  const onAgreements = meanOf(
    numbersOf(
      measured.filter((pair) => !isDisagreement(pair)),
      key,
    ),
  );
  return {
    ...(onDisagreements === undefined ? {} : { disagreements: onDisagreements }),
    ...(onAgreements === undefined ? {} : { agreements: onAgreements }),
  };
}

function groupOf(pairs: readonly MatchedLabel[], key: string): EvalMetricGroup {
  const measured = pairs.filter((pair) => pair.verdict.metrics?.[key] !== undefined);
  const disagreements = measured.filter(isDisagreement).length;
  const counts = { key, disagreements, agreements: measured.length - disagreements };
  const isNumeric = measured.every((pair) => typeof pair.verdict.metrics?.[key] === "number");
  return isNumeric
    ? { ...counts, mean: meanGroupOf(measured, key) }
    : { ...counts, values: valuesOf(measured, key) };
}

/** Every metric key the judge measured on its labelled runs, in the order first seen. */
export function metricGroupsOf(pairs: readonly MatchedLabel[]): readonly EvalMetricGroup[] {
  const keys = new Set(pairs.flatMap((pair) => Object.keys(pair.verdict.metrics ?? {})));
  return [...keys].map((key) => groupOf(pairs, key));
}

const SCORES = [1, 2, 3, 4] as const;

/** The scores given, by the judge's verdict; undefined when no label has one. */
export function scoreCountsOf(pairs: readonly MatchedLabel[]): EvalScoreCounts | undefined {
  if (pairs.every((pair) => pair.label.score === undefined)) return undefined;
  const countFor = (judgePassed: boolean): number[] =>
    SCORES.map(
      (score) =>
        pairs.filter((pair) => pair.verdict.passed === judgePassed && pair.label.score === score)
          .length,
    );
  return { judgePassed: countFor(true), judgeFailed: countFor(false) };
}
