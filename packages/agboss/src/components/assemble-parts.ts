import type { AssembledWorkflow, ResolvedPolicies, WorkflowServices } from "../workflow.js";
import type { Guardrail } from "./decorators.js";
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

/** Guardrail classes by agent name and by tool name. */
export interface PolicyMaps {
  readonly agentGuardrails: ReadonlyMap<string, PolicyClasses>;
  readonly toolGuardrails: ReadonlyMap<string, PolicyClasses>;
}

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

/** The guardrail classes of every agent and every local tool (tools by their tool name). */
export function policyMapsOf(
  agents: readonly AgentMeta[],
  localTools: readonly Class[],
  names: ReadonlyMap<Class, string>,
): PolicyMaps {
  const toolName = (cls: Class): string => names.get(cls) ?? cls.name;
  return {
    agentGuardrails: new Map(agents.map((a) => [a.name, guardrailClassesOf(a)])),
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
  "resolve" | "guardrails" | "toolGuardrails" | "workflowGuardrails"
>;

/** The guardrails of a workflow, created by its container. */
export function containerPartsOf(bundle: WorkflowMeta, policies: PolicyMaps): ContainerParts {
  const get = (services: WorkflowServices, cls: Class): unknown =>
    containerFor(bundle, services).get(cls);
  const guardrail = (services: WorkflowServices) => (cls: Class) => get(services, cls) as Guardrail;
  const wfGuardrails = bundle.guardrails ?? [];
  return {
    resolve: (services) => (cls) => get(services, cls),
    guardrails: (services) => resolvePolicies(policies.agentGuardrails, guardrail(services)),
    toolGuardrails: (services) => resolvePolicies(policies.toolGuardrails, guardrail(services)),
    workflowGuardrails: (services) => wfGuardrails.map(guardrail(services)),
  };
}
