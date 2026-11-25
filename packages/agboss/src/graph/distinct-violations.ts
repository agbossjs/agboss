import type { RuleViolation } from "./rule-error.js";

/**
 * Each violation once, in the order found: a class shared by several workflows is reached from each
 * of them, and a rule the application and a workflow both run (a provider's timeout) finds the same
 * problem from both. One code and message is one violation; the nodes that reached it are joined.
 */
export const distinctViolations = (violations: readonly RuleViolation[]): RuleViolation[] => {
  const found = new Map<string, RuleViolation>();
  for (const item of violations) {
    const key = `${item.code}\u0000${item.message}`;
    const seen = found.get(key);
    found.set(
      key,
      seen === undefined ? item : { ...seen, nodes: [...new Set([...seen.nodes, ...item.nodes])] },
    );
  }
  return [...found.values()];
};
