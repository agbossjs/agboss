import { RagMode } from "../rag/types.js";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";
import type { RagConnector } from "../rag/types.js";
import type { RouterEngine } from "../routers/index.js";
import { schemaOf } from "../dto/schema.js";
import { defineTool, type AnyTool, type Tool } from "../tools/index.js";
import { accountedRouters } from "./accounted-router.js";
import { LiveJudgeModel } from "./judge-call.js";
import { LiveSpendRecorder, SpendRecorder } from "./spend-recorder.js";
import { JudgeModel } from "./judge-decorators.js";
import { ExecutionContext } from "../flow/context/execution-context.js";
import { LiveExecutionContext } from "../flow/context/live-context.js";
import { createContainer, DependantValue, type Container } from "./container/container.js";
import { ENV, environmentValueOf } from "./environment-token.js";
import type { ProviderModule } from "./container/registrations.js";
import type { ToolHandler } from "./decorators.js";
import { InjectionToken, type Class, type Token } from "./injection.js";
import { componentOf, requireComponent, type ToolMeta } from "./metadata.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import { contextSources, ragMeta, searchTool } from "./rag.js";

/** What a workflow creates per run of the app: the container, tool instances, knowledge sources. */

export { ENV } from "./environment-token.js";

/** Core services a component can depend on. */
export const ROUTER_FACTORY = new InjectionToken<(name: string) => RouterEngine>("ROUTER_FACTORY");
/** `deps: [ExecutionContext]`: a live object per consumer, reading the current step (#280). */
const liveExecutionContext = new DependantValue((dependant) => new LiveExecutionContext(dependant));
/** `deps: [JudgeModel]` in a `@Judge`: the model of the judge that is judging (#280). */
const liveJudgeModel = new DependantValue((dependant) => new LiveJudgeModel(dependant));
/** `deps: [SpendRecorder]`: what a tool or an action paid a service, into its step's spend (S43). */
const liveSpendRecorder = new DependantValue((dependant) => new LiveSpendRecorder(dependant));
export const CORE_TOKENS = [ROUTER_FACTORY, ENV, ExecutionContext, JudgeModel, SpendRecorder];

/**
 * A tool component instance as the core's tool (validation, timeout, errors to the model), typed
 * from its `run` — e.g. in tests: `toolOf(new GreenhouseJobs(fakeJudge, search, fakeFetch))`, then
 * `.invoke(input)`.
 */
export function toolOf<TInput, TOutput>(instance: {
  run: (input: TInput) => Promise<TOutput>;
}): Tool<string, TInput, TOutput> {
  const cls = instance.constructor as Class;
  const { meta } =
    componentOf(cls)?.kind === "mcp-tool"
      ? requireComponent(cls, "mcp-tool", "toolOf")
      : requireComponent(cls, "tool", "toolOf");
  // The decorator's DTOs are erased in metadata; `run` is what they validate for.
  return adapt(instance, meta) as unknown as Tool<string, TInput, TOutput>;
}

/** The startup check of a tool's DTOs (undecorated fields, behaviour) — before any run. */
export const checkToolData = (cls: Class, kind: "tool" | "mcp-tool"): void => {
  const { meta } = requireComponent(cls, kind, "workflowOf");
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
    ...(meta.channel === undefined
      ? {}
      : { channel: requireComponent(meta.channel, "channel", "toolOf").meta.name }),
    ...(meta.timeoutMs === undefined ? {} : { timeoutMs: meta.timeoutMs }),
    run: (input) => handler.run(input),
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
  { owner: bundle.name, providers: bundle.providers ?? [] },
];

/** One container per app instance (its services): its tools, knowledge and index share instances. */
const containers = new WeakMap<WorkflowMeta, WeakMap<WorkflowServices, Container>>();
export const containerFor = (bundle: WorkflowMeta, services: WorkflowServices): Container => {
  const perBundle = containers.get(bundle) ?? new WeakMap<WorkflowServices, Container>();
  containers.set(bundle, perBundle);
  const existing = perBundle.get(services);
  if (existing !== undefined) return existing;
  const core = new Map<Token, unknown>([
    [ROUTER_FACTORY, accountedRouters(services.router)],
    [ENV, environmentValueOf(services.environment)],
    [ExecutionContext, liveExecutionContext],
    [JudgeModel, liveJudgeModel],
    [SpendRecorder, liveSpendRecorder],
  ]);
  for (const [token, instance] of serverInstances.get(bundle) ?? []) core.set(token, instance);
  const container = createContainer(
    { modules: providerModulesOf(bundle), core },
    services.container,
  );
  perBundle.set(services, container);
  return container;
};

/** Tools per run of the app: tools and MCP tools (created by the container), knowledge-base search tools. */
export const toolBuilder =
  (
    bundle: WorkflowMeta,
    agents: readonly AgentMeta[],
    local: readonly Class[],
    mcpTools: readonly Class[],
    serverNames: ReadonlyMap<Class, string>,
  ) =>
  (services: WorkflowServices): readonly AnyTool[] => {
    const container = containerFor(bundle, services);
    const instances = local.map((cls) =>
      adapt(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        container.get(cls) as ToolHandler<any, any>,
        requireComponent(cls, "tool", "workflowOf").meta,
      ),
    );
    const mcp = mcpTools.map((cls) => {
      const { meta } = requireComponent(cls, "mcp-tool", "workflowOf");
      const tool = adapt(container.get(cls) as ToolHandler<unknown, unknown>, meta);
      return { ...tool, mcp: { server: serverNames.get(meta.server) ?? "", tool: meta.name } };
    });
    const searched = [
      ...new Set(
        agents.flatMap((a) =>
          (a.rag ?? []).filter((b) => b.mode === RagMode.Tool).map((b) => b.use),
        ),
      ),
    ];
    const search = searched.map((cls) =>
      searchTool(ragMeta(cls), container.get(cls) as RagConnector),
    );
    return [...instances, ...mcp, ...search];
  };

export const ragParts = (
  bundle: WorkflowMeta,
  agents: readonly AgentMeta[],
  rags: readonly Class[],
): Required<Pick<AssembledWorkflow, "knowledge" | "knowledgeBases">> => ({
  knowledge: (services: WorkflowServices) =>
    contextSources(agents, (cls) => containerFor(bundle, services).get(cls) as RagConnector),
  knowledgeBases: (services: WorkflowServices) =>
    rags.map((cls) => ({
      name: ragMeta(cls).name,
      connector: containerFor(bundle, services).get(cls) as RagConnector,
    })),
});
