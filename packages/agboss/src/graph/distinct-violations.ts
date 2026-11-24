import type { RuleViolation } from "./rule-error.js";

/** Each violation once, in the order found: a class shared by several workflows is reached from each of them. */
export const distinctViolations = (violations: readonly RuleViolation[]): RuleViolation[] => [
  ...new Map(
    violations.map((item) => [
      `${item.code}\u0000${item.message}\u0000${item.nodes.join(",")}`,
      item,
    ]),
  ).values(),
];
