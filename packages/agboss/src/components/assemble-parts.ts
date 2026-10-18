import type { AssembledWorkflow, ResolvedPolicies, WorkflowServices } from "../workflow.js";
import type { Guardrail, PiiPolicy } from "./decorators.js";
import type { Class } from "./injection.js";
import { componentOf } from "./metadata.js";
import type { AgentMeta, PolicyFields, WorkflowMeta } from "./meta-types.js";
import { containerFor } from "./runtime.js";

/** Per agent or tool: its policy classes, and whether they replace the workflow's own. */
interface PolicyClasses {
  readonly override: boolean;
  readonly classes: readonly Class[];
  readonly disable: readonly Class[];
}

/** Policy classes by agent name and by tool name. */
export interface PolicyMaps {
  readonly agentPii: ReadonlyMap<string, PolicyClasses>;
  readonly agentGuardrails: ReadonlyMap<string, PolicyClasses>;
  readonly toolPii: ReadonlyMap<string, PolicyClasses>;
  readonly toolGuardrails: ReadonlyMap<string, PolicyClasses>;
}

const piiClassesOf = (fields: PolicyFields): PolicyClasses =>
  fields.overridePiiPolicies
    ? {
        override: true,
        classes: fields.overridePiiPolicies,
        disable: fields.disablePiiPolicies ?? [],
      }
    : {
        override: false,
        classes: fields.piiPolicies ?? [],
        disable: fields.disablePiiPolicies ?? [],
      };

const guardrailClassesOf = (fields: PolicyFields): PolicyClasses =>
  fields.overrideGuardrails
    ? {
        override: true,
        classes: fields.overrideGuardrails,
        disable: fields.disableGuardrails ?? [],
      }
    : {
        override: false,
        classes: fields.guardrails ?? [],
        disable: fields.disableGuardrails ?? [],
      };

/** A tool's policy settings, as `@Tool` recorded them in its `ToolMeta`. */
function toolPolicyFields(cls: Class): PolicyFields {
  const component = componentOf(cls);
  return component?.kind === "tool" ? component.meta : {};
}

/** The policy classes of every agent and every local tool (tools by their tool name). */
export function policyMapsOf(
  agents: readonly AgentMeta[],
  localTools: readonly Class[],
  names: ReadonlyMap<Class, string>,
): PolicyMaps {
  const toolName = (cls: Class): string => names.get(cls) ?? cls.name;
  return {
    agentPii: new Map(agents.map((a) => [a.name, piiClassesOf(a)])),
    agentGuardrails: new Map(agents.map((a) => [a.name, guardrailClassesOf(a)])),
    toolPii: new Map(localTools.map((t) => [toolName(t), piiClassesOf(toolPolicyFields(t))])),
    toolGuardrails: new Map(
      localTools.map((t) => [toolName(t), guardrailClassesOf(toolPolicyFields(t))]),
    ),
  };
}

function resolvePolicies<TPolicy>(
  map: ReadonlyMap<string, PolicyClasses>,
  instanceOf: (cls: Class) => TPolicy,
): Map<string, ResolvedPolicies<TPolicy>> {
  return new Map(
    Array.from(map.entries()).map(([key, value]) => [
      key,
      {
        override: value.override,
        instances: value.classes.map(instanceOf),
        disable: value.disable,
      },
    ]),
  );
}

/** The parts of a workflow whose instances come from its container (per `services`). */
export type ContainerParts = Pick<
  AssembledWorkflow,
  | "resolve"
  | "piiPolicies"
  | "guardrails"
  | "toolPiiPolicies"
  | "toolGuardrails"
  | "workflowPiiPolicies"
  | "workflowGuardrails"
>;

/** The policies of a workflow, created by its container. */
export function containerPartsOf(bundle: WorkflowMeta, policies: PolicyMaps): ContainerParts {
  const get = (services: WorkflowServices, cls: Class): unknown =>
    containerFor(bundle, services).get(cls);
  const pii = (services: WorkflowServices) => (cls: Class) => get(services, cls) as PiiPolicy;
  const guardrail = (services: WorkflowServices) => (cls: Class) => get(services, cls) as Guardrail;
  const wfPii = bundle.piiPolicies ?? [];
  const wfGuardrails = bundle.guardrails ?? [];
  return {
    resolve: (services) => (cls) => get(services, cls),
    piiPolicies: (services) => resolvePolicies(policies.agentPii, pii(services)),
    guardrails: (services) => resolvePolicies(policies.agentGuardrails, guardrail(services)),
    toolPiiPolicies: (services) => resolvePolicies(policies.toolPii, pii(services)),
    toolGuardrails: (services) => resolvePolicies(policies.toolGuardrails, guardrail(services)),
    workflowPiiPolicies: (services) => wfPii.map(pii(services)),
    workflowGuardrails: (services) => wfGuardrails.map(guardrail(services)),
  };
}
