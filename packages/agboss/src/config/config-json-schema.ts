import { z } from "zod";
import type { AssembledApplication } from "../application/assemble.js";
import {
  MemoryOverlaySchema,
  ModelProviderOverlaySchema,
  ScalarOverlaySchema,
  WorkflowOverlaySchema,
} from "./overlay-schema.js";
import { budgetOf } from "../budgets/budget.js";
import { budgetsOfApplication } from "../budgets/budget-rules.js";
import { modelProviderOf } from "../models/model-provider.decorator.js";

type Schema = Record<string, unknown>;

const json = (schema: z.ZodType): Schema =>
  z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });

const objectOf = (properties: Readonly<Record<string, unknown>>): Schema => ({
  type: "object",
  properties,
  additionalProperties: false,
});

const budgetSchema: Schema = objectOf({
  maxSpend: { type: "number", exclusiveMinimum: 0 },
  maxTokens: { type: "integer", exclusiveMinimum: 0 },
});

const propertiesOf = (schema: Schema): Schema => (schema.properties ?? {}) as Schema;

/** One workflow's overlay with its agents and memories named: a typo in a name is a squiggle. */
function workflowSchema(config: AssembledApplication["workflows"][number]["config"]): Schema {
  const base = json(WorkflowOverlaySchema);
  const props = propertiesOf(base);
  const agent = (props.agents as Schema | undefined)?.additionalProperties;
  const named = (names: readonly string[], one: unknown): Schema =>
    objectOf(Object.fromEntries(names.map((name) => [name, one])));
  return {
    ...base,
    properties: {
      ...props,
      agents: named(Object.keys(config.agents), agent),
      prompts: named(Object.keys(config.agents), (props.prompts as Schema).additionalProperties),
    },
  };
}

/**
 * `.agboss/config.schema.json` — the JSON Schema of a `.config.yaml` typed by this project: its
 * workflows by name (and `"*"`), each one's agents, its model providers by name. For
 * `# $schema: ../../.agboss/config.schema.json` in the editor.
 */
export function configJsonSchemaOf(assembled: AssembledApplication): Schema {
  const base = json(ScalarOverlaySchema);
  const props = propertiesOf(base);
  const workflows = Object.fromEntries(
    assembled.workflows.map((one) => [one.config.name, workflowSchema(one.config)]),
  );
  const everyWorkflow = (props.workflows as Schema).additionalProperties;
  const providers = [...new Set(assembled.workflows.flatMap((one) => one.modelProviders))].map(
    (cls) => modelProviderOf(cls).name,
  );
  const providerSchema = json(ModelProviderOverlaySchema);
  const budgets = budgetsOfApplication({
    budgets: assembled.budgets,
    workflows: assembled.workflows.map((one) => one.graph.type),
  }).flatMap((cls) => budgetOf(cls) ?? []);
  const memorySchema = json(MemoryOverlaySchema);
  const memories = new Set(
    assembled.workflows.flatMap((one) =>
      (one.memories?.memories ?? []).map((memory) => memory.name),
    ),
  );
  return {
    ...base,
    properties: {
      ...props,
      memories: objectOf(Object.fromEntries([...memories].map((name) => [name, memorySchema]))),
      workflows: objectOf({ "*": everyWorkflow, ...workflows }),
      modelProviders: objectOf(Object.fromEntries(providers.map((name) => [name, providerSchema]))),
      // a YAML file holds numbers; a budget that reads its limits in limit() has no entry
      budgets: objectOf(
        Object.fromEntries(
          budgets
            .filter((meta) => meta.maxSpend !== undefined || meta.maxTokens !== undefined)
            .map((meta) => [meta.name, budgetSchema]),
        ),
      ),
    },
  };
}
