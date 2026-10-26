import {
  COST_CATEGORIES,
  type CostLine,
  type CostReport,
  type CostSource,
} from "@agboss/core/internal";

/** How each call was priced: tokens × price table, exact price from the API, or the tool's own report. */
const BASIS: Readonly<Record<CostSource, (line: CostLine) => string>> = {
  "price-table": (line) => `${String(line.inputTokens)} in / ${String(line.outputTokens)} out`,
  api: () => "api-priced",
  tool: () => "tool-reported",
};

const usd = (value: number): string => `$${value.toFixed(6)}`;

/** Categories that cost something: "agents $0.003378 · routing $0.000050 · guards $0.000044". */
export function costSummary(cost: CostReport): string {
  const parts = COST_CATEGORIES.filter((category) => cost.byCategory[category] > 0).map(
    (category) => `${category} ${usd(cost.byCategory[category])}`,
  );
  return parts.length === 0 ? "no paid calls" : parts.join(" · ");
}

/** "total $0.003471 (7 calls)" */
export const costTotal = (cost: CostReport): string =>
  `total ${usd(cost.totalUsd)} (${String(cost.calls)} calls)`;

/** One line per call, in order: n. caller  model  cost  tokens in/out. */
export function costTrace(cost: CostReport): string[] {
  const width = Math.max(0, ...cost.trace.map((line) => line.caller.length));
  const modelWidth = Math.max(0, ...cost.trace.map((line) => line.model.length));
  return cost.trace.map((line, index) => {
    const basis = BASIS[line.costSource](line);
    return `${String(index + 1).padStart(2)}. ${line.caller.padEnd(width)}  ${line.model.padEnd(modelWidth)}  ${usd(line.costUsd)}  ${basis}`;
  });
}
