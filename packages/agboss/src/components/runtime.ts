import { ConfigError } from "../core/error-families/config-errors.js";
import { ComponentOptions } from "./component-options.js";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";
import {
  bindRagRuntime,
  indexOf,
  RagSource,
  ragRuntimeOf as boundRagRuntimeOf,
  type RagRuntime,
} from "../rag/rag-source.js";
import type { RouterEngine } from "../routers/index.js";
import { z } from "zod";
import { schemaOf } from "../dto/schema.js";
import { defineTool, type AnyTool, type Tool } from "../tools/index.js";
import { DecisionModel } from "./decision-model.js";
import { liveCoreValuesOf } from "./live-core-values.js";
import { accountedRouters } from "./accounted-router.js";
import { ArbiterModel } from "../flow/decorators/arbiter.js";
import { SpendRecorder } from "./spend-recorder.js";
import { JudgeModel } from "./judge-decorators.js";
import { deferredEnvOf } from "../environments/define-env.js";
import { contextsOutsideExecution } from "../flow/context/runtime-contexts.js";
import { CONTEXT_TOKENS, contextValuesOf } from "./context-tokens.js";
import { createContainer, type Container } from "./container/container.js";
import type { ProviderModule } from "./container/registrations.js";
import type { ToolHandler } from "./decorators.js";
import { InjectionToken, type Class, type Token } from "./injection.js";
import { componentOf, requireComponent, type ToolMeta } from "./metadata.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import { contextSources, ragMeta } from "./rag.js";
import { buildRagRuntime } from "./rag-retrieval.js";
import { externalTaskOf } from "../channels/discovery.js";
import { targetNameOf, type ExternalTaskOptions } from "../channels/pause-targets.js";
import type { ToolClasses } from "./assemble-checks.js";
import { IDEMPOTENCY_OUTSIDE_APPLICATION, Idempotency } from "../app/idempotency.js";
import { standaloneStorageEntriesOf } from "../storage/standalone-storage.js";

/** What a workflow creates per run of the app: the container, tool instances, knowledge sources. */

/** Core services a component can depend on. */
export const ROUTER_FACTORY = new InjectionToken<(name: string) => RouterEngine>("ROUTER_FACTORY");
export const CORE_TOKENS = [
  ROUTER_FACTORY,
  ...CONTEXT_TOKENS,
  JudgeModel,
  ArbiterModel,
  SpendRecorder,
  DecisionModel,
  ComponentOptions,
];

/**
 * A tool component instance as the core's tool (validation, timeout, errors to the model), typed
 * from its `execute` — e.g. in tests: `toolOf(new GreenhouseJobs(fakeJudge, search, fakeFetch))`, then
 * `.invoke(input)`.
 */
export function toolOf<TInput, TOutput>(instance: {
  execute: (input: TInput) => TOutput | Promise<TOutput>;
}): Tool<string, TInput, TOutput> {
  const cls = instance.constructor as Class;
  const { meta } = requireComponent(cls, "tool", "toolOf");
  // The decorator's DTOs are erased in metadata; `execute` is what they validate for.
  return adapt(instance, meta) as unknown as Tool<string, TInput, TOutput>;
}

/** The startup check of a tool's DTOs (undecorated fields, behaviour) — before any run. */
export const checkToolData = (cls: Class): void => {
  const { meta } = requireComponent(cls, "tool", "workflowOf");
  schemaOf(meta.input);
  schemaOf(meta.output);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const adapt = (handler: ToolHandler<any, any>, meta: ToolMeta): AnyTool =>
  defineTool({
    name: meta.name,
    description: meta.description,
    input: schemaOf(meta.input),
    output: schemaOf(meta.output),
    ...(meta.approval === undefined ? {} : { approval: targetNameOf(meta.approval) }),
    ...(meta.timeout === undefined ? {} : { timeout: meta.timeout }),
    ...(meta.maxResultSize === undefined ? {} : { maxResultSize: meta.maxResultSize }),
    run: async (input): Promise<unknown> => {
      const output: unknown = await handler.execute(input);
      return output;
    },
  });

/** Each workflow's MCP server instances (with their connected tools): injected like any dependency. */
const serverInstances = new WeakMap<WorkflowMeta, ReadonlyMap<Token, unknown>>();
export const rememberServers = (
  bundle: WorkflowMeta,
  instances: ReadonlyMap<Token, unknown>,
): void => {
  serverInstances.set(bundle, instances);
};

/** The workflow's providers as modules of the app's container (#261: one container per app). */
export const providerModulesOf = (bundle: WorkflowMeta): readonly ProviderModule[] => [
  bundle.services === undefined
    ? { owner: bundle.name, providers: bundle.providers ?? [] }
    : {
        owner: bundle.name,
        providers: [...(bundle.providers ?? []), ...bundle.services],
        services: bundle.services,
      },
];

/** One container per app instance (its services): its tools, knowledge and index share instances. */
const containers = new WeakMap<WorkflowMeta, WeakMap<WorkflowServices, Container>>();
export const containerFor = (bundle: WorkflowMeta, services: WorkflowServices): Container => {
  const perBundle = containers.get(bundle) ?? new WeakMap<WorkflowServices, Container>();
  containers.set(bundle, perBundle);
  const existing = perBundle.get(services);
  if (existing !== undefined) return existing;
  // the application's contexts (#261: `deps: [ApplicationContext]`, …); a workflow on its own has its own
  const contexts = services.contexts ?? contextsOutsideExecution(bundle);
  const core = new Map<Token, unknown>([
    [ROUTER_FACTORY, accountedRouters(services.router)],
    ...contextValuesOf(contexts),
    ...liveCoreValuesOf(services),
  ]);
  for (const [token, instance] of serverInstances.get(bundle) ?? []) core.set(token, instance);
  // #890: no application's container (`agboss check`, a workflow on its own) has no fenced-effect store
  if (services.container === undefined) {
    core.set(Idempotency, IDEMPOTENCY_OUTSIDE_APPLICATION);
    for (const [token, settings] of standaloneStorageEntriesOf(bundle)) core.set(token, settings);
  }
  const container: Container = createContainer(
    { modules: providerModulesOf(bundle), core },
    {
      ...services.container,
      // no application's container (`agboss check`, `describe`): types and the tool graph need no key (#266) — a
      // secret behind `deps: [appEnv]` stays unresolved, its variable named by the report instead of failing the build
      ...(services.container === undefined ? { envOf: deferredEnvOf } : {}),
      // a `@Rag` source gets its pipeline (scope, reranker, spend) when the container creates it
      onCreate: (instance) => {
        services.container?.onCreate?.(instance);
        if (instance instanceof RagSource)
          bindRag(instance, bundle, services, (cls) => container.get(cls));
      },
    },
  );
  perBundle.set(services, container);
  return container;
};

/**
 * An external task as an agent's tool (#712): `@Agent({ tools: [SpendingLimitExternalTask] })`. Its
 * model sees a tool named the task's name, described by the task's description, whose input is the
 * task's `input`; the loop asks the task's channel at the call (the approval step, through the pause
 * seam) and the task's `output` is the call's result. The tool itself runs nothing: called without
 * a pause seam — an agent loop on its own — it is a tool error its model reads.
 */

/** Why a question is no tool call on its own: it waits for an answer only an application records. */
const UNASKED =
  "a question is asked only inside its application: its answer comes through the application's pauses";

/** The tool a question role is to the agents that list it. */
export function questionToolOf(task: ExternalTaskOptions): AnyTool {
  const tool = defineTool({
    name: task.name,
    description: task.description,
    // strict: arguments with a field the ask does not declare are no valid ask (never passed on)
    input: strictObjectOf(schemaOf(task.input)),
    output: schemaOf(task.output),
    approval: task.name,
    run: () => Promise.reject(new Error(UNASKED)),
  });
  const { input: ask, output: answer, maxVisits } = task;
  const question = { ask, answer, ...(maxVisits === undefined ? {} : { maxVisits }) };
  return { ...tool, question };
}

/** An object schema that refuses the keys it does not declare. */
const strictObjectOf = (schema: z.ZodType): z.ZodType =>
  schema instanceof z.ZodObject ? schema.strict() : schema;

/** Tools per run of the app: tools (created by the container). */
export const toolBuilder =
  (bundle: WorkflowMeta, tools: ToolClasses) =>
  (services: WorkflowServices): readonly AnyTool[] => {
    const { local } = tools;
    const container = containerFor(bundle, services);
    const instances = local.map((cls) =>
      adapt(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        container.get(cls) as ToolHandler<any, any>,
        requireComponent(cls, "tool", "workflowOf").meta,
      ),
    );
    const asked = (tools.asked ?? []).flatMap((cls) => {
      const task = externalTaskOf(cls);
      return task === undefined ? [] : [questionToolOf(task)];
    });
    return [...instances, ...asked];
  };

/** Binds a created `@Rag` source to its pipeline: its scope, reranker and spend (internal). */
function bindRag(
  source: object,
  bundle: WorkflowMeta,
  services: WorkflowServices,
  instance: (cls: Class) => unknown,
): void {
  const cls = source.constructor as Class;
  if (componentOf(cls)?.kind !== "rag") return;
  bindRagRuntime(
    source,
    buildRagRuntime(ragMeta(cls), source, instance, services, bundle.modelCascade ?? {}),
  );
}

/** A created `@Rag` source's pipeline; one the container did not create has none. */
function runtimeOf(source: unknown): RagRuntime {
  const runtime =
    typeof source === "object" && source !== null ? boundRagRuntimeOf(source) : undefined;
  if (runtime === undefined)
    throw new ConfigError.Component({
      message:
        "[rag.unbound] a @Rag listed in an agent's rag is no RagSource the application created — extend RagSource",
    });
  return runtime;
}

export const ragParts = (
  bundle: WorkflowMeta,
  agents: readonly AgentMeta[],
  rags: readonly Class[],
): Required<Pick<AssembledWorkflow, "knowledge" | "knowledgeBases">> => ({
  knowledge: (services: WorkflowServices) =>
    contextSources(agents, (cls) => runtimeOf(containerFor(bundle, services).get(cls))),
  knowledgeBases: (services: WorkflowServices) =>
    rags.map((cls) => {
      const meta = ragMeta(cls);
      const source = containerFor(bundle, services).get(cls) as object;
      return {
        name: meta.name,
        scope: meta.scope,
        index: (options) => indexOf(source, options),
      };
    }),
});
