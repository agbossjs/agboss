import { a2aFileStoreViolations } from "../a2a/a2a-file-store-rule.js";
import { contractRuleViolations } from "../a2a/a2a-rules.js";
import type { ComponentOptions } from "../components/component-options.js";
import type { RuleViolation } from "../graph/rule-error.js";
import type { ApplicationOptions } from "./application.js";

/**
 * The application rules that read what the selected profiles change of the components (#1318c): the
 * A2A contracts (an endpoint\'s ttl, an agent\'s price) and the A2A files (every policy). They read the
 * carrier of the components\' options, never a declaration, so what is checked is what runs.
 */
export const carrierRuleViolations = (
  options: ApplicationOptions,
  carrier: ComponentOptions,
): RuleViolation[] => [
  ...contractRuleViolations(options, carrier),
  ...a2aFileStoreViolations(options, carrier),
];
