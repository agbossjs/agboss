import type { McpServerConfig } from "../config/mcp-server-config.js";
import type { DtoClass } from "../dto/types.js";
import type { Bytes, Milliseconds, WorkingDuration } from "../units/index.js";
import type { ServerTools } from "./mcp-client.js";
import type { Class, Token } from "./injection.js";
import type { ChannelOptions } from "./decorators.js";
import type { McpEndpointOptions } from "../mcp/mcp-endpoint.decorator.js";
import { AGBossError, type MessageErrorOptions } from "../core/errors.js";

/** `@Tool` — its options as recorded. */
export interface ToolMeta {
  readonly name: string;
  readonly description: string;
  readonly prompt?: string;
  readonly promptUrls?: readonly string[];
  readonly channel?: Class;
  /** The `@ToolApproval` it was given as `approval` (#1307); `channel` holds the same class. */
  readonly approval?: Class;
  /** Whether it only reads (#860): what a direct-reply A2A skill's agents may call. */
  readonly readOnly?: boolean;
  /** How long one call may run (`seconds(5)`); default 30 s. */
  readonly timeout?: Milliseconds;
  /** The deadline of its approval pause (#941), over its channel role's; only with `channel`. */
  readonly expiresIn?: Milliseconds | WorkingDuration;
  /** What a model reads of one result at most (`kilobytes(256)`); default `defaults.tools`. */
  readonly maxResultSize?: Bytes;
  /** `@ToolInterceptor` classes of this tool, over its agent's, workflow's and application's (#384). */
  readonly toolInterceptors?: readonly Class[];
  /** Inherited tool interceptors this tool removes (#384). */
  readonly excludeToolInterceptors?: readonly Class[];
  readonly input: DtoClass;
  readonly output: DtoClass;
  readonly deps: readonly Token[];
}

/** What a decorator recorded about a class. */
export type ComponentMeta =
  | { readonly kind: "tool"; readonly meta: ToolMeta }
  | {
      readonly kind: "mcp-server";
      readonly meta: {
        readonly name: string;
        readonly config: McpServerConfig;
        readonly tools: ServerTools;
      };
    }
  /** `@McpEndpoint` (`@agboss/core/mcp`): what `connectMcp` / `mcpHttpListener` expose to MCP clients. */
  | { readonly kind: "mcp-endpoint"; readonly meta: McpEndpointOptions }
  /** `@A2AEndpoint` (`@agboss/core/a2a`, #1320): what `a2aHttpListener` serves to A2A callers. */
  | {
      readonly kind: "a2a-endpoint";
      readonly meta: import("../a2a/a2a-endpoint.decorator.js").A2AEndpointMeta;
    }
  | {
      readonly kind: "channel";
      readonly meta: ChannelOptions & { readonly deps: readonly Token[] };
    }
  | { readonly kind: "injectable"; readonly meta: { readonly deps: readonly Token[] } }
  | {
      readonly kind: "rag";
      readonly meta: {
        readonly name: string;
        readonly description: string;
        /** Whose content it serves; checked at assembly — a JS caller may leave it out. */
        readonly scope: import("../rag/types.js").RagScope;
        /** What the agent gets per retrieval. */
        readonly topK: number;
        /** A `@RagReranker` class: fetch its `candidates`, keep `topK`. */
        readonly reranker?: Class;
        readonly deps: readonly Token[];
      };
    }
  /** `@RagReranker`: re-orders a knowledge base's candidates — by model or by code. */
  | {
      readonly kind: "reranker";
      readonly meta: import("../rag/reranker.decorator.js").RecordedRerankerMeta;
    }
  /** `@PiiPolicy` (#120): declarative rules, or a project's own detector. */
  | {
      readonly kind: "pii-policy";
      readonly meta: import("../pii/pii-policy.decorator.js").PiiPolicyMeta;
    }
  /** `@InputGuardrail` / `@OutputGuardrail` (#120). */
  | {
      readonly kind: "guardrail";
      readonly meta: import("./policy-decorators.js").GuardrailMeta;
    }
  /** `@ToolInterceptor` (#384): before / after an agent's tool calls. */
  | {
      readonly kind: "tool-interceptor";
      readonly meta: import("../tool-interceptors/decorator.js").ToolInterceptorMeta;
    }
  /** `@Memory` (#1303): how long a thread is kept, what readers see of it and how old turns are summarised. */
  | {
      readonly kind: "memory";
      readonly meta: import("../memory/memory.decorator.js").MemoryMeta;
    }
  /** `@Mesh` (#1320): the application's identity and rules in the mesh, listed in `@Application({ mesh })`. */
  | { readonly kind: "mesh"; readonly meta: import("../mesh/mesh.decorator.js").MeshMeta }
  | {
      readonly kind: "judge";
      readonly meta: import("./judge-decorators.js").JudgeRecord;
    }
  /** `@Budget` (#261): a money limit, listed in `@Application({ budgets })`. */
  | { readonly kind: "budget"; readonly meta: import("../budgets/budget.js").BudgetMeta }
  /** `@HealthCheck` (#300): a readiness check, listed in `@Application({ healthChecks })`. */
  | {
      readonly kind: "health-check";
      readonly meta: import("../health/health-check.js").HealthCheckMeta;
    }
  /** `@ChannelSelector` (#1307): picks the channel when two or more serve one target. */
  | {
      readonly kind: "channel-selector";
      readonly meta: import("../channels/channel-selector.js").ChannelSelectorMeta;
    }
  /** `@HttpAuthenticator` (#1316): who calls an HTTP listener, named by the listener's `authenticator`. */
  | {
      readonly kind: "http-authenticator";
      readonly meta: import("../http/http-authenticator.js").HttpAuthenticatorMeta;
    }
  /** `@FilePolicy` (#1316): what a workflow's files may be, named by `filePolicy` on `@Workflow`. */
  | {
      readonly kind: "file-policy";
      readonly meta: import("../files/file-policy.js").FilePolicyMeta;
    }
  /** `@Observer` (#1343): an execution observer, listed in `@Application({ observers })`. */
  | { readonly kind: "observer"; readonly meta: import("../core/observer-hooks.js").ObserverMeta }
  /** `@PauseListener` (#940): an application-wide listener of every pause, listed in `providers`. */
  | {
      readonly kind: "pause-listener";
      readonly meta: import("../pause/pause-listener.js").PauseListenerMeta;
    }
  /** `@WorkingCalendar` (#944): a working-time calendar, listed in `providers`. */
  | {
      readonly kind: "working-calendar";
      readonly meta: import("../calendar/working-calendar.js").WorkingCalendarMeta;
    }
  | { readonly kind: "a2a-agent"; readonly meta: import("../a2a/a2a-decorator.js").A2AAgentMeta }
  /** `@DatabaseStorage` / `@ClusterStorage` / `@ObjectStorage` (#1321): where the rows go, listed in `@Application({ storage })`. */
  | {
      readonly kind: "database-storage";
      readonly meta: import("../storage/storage-decorators.js").DatabaseStorageMeta;
    }
  | {
      readonly kind: "cluster-storage";
      readonly meta: import("../storage/storage-decorators.js").ClusterStorageMeta;
    }
  | {
      readonly kind: "object-storage";
      readonly meta: import("../storage/storage-decorators.js").ObjectStorageMeta;
    };

/** Decorator metadata per class. Symbol.metadata is not available at runtime on Node 26. */
const components = new WeakMap<object, ComponentMeta>();

export const recordComponent = (target: object, meta: ComponentMeta): void => {
  components.set(target, meta);
};

export const componentOf = (target: object): ComponentMeta | undefined => components.get(target);

/**
 * A component that is declared wrong (#906): a class that is not the component it is used as, a
 * prompt, an environment, an A2A declaration. Its instance `code` is the union of its family.
 */
export class ComponentError extends AGBossError {
  static override readonly code: string = "component";
  declare readonly code: "component" | "component.prompt" | "component.no-default-router";
  override name = "ComponentError";

  constructor(options: MessageErrorOptions) {
    super(options.message, options);
  }
}

export function requireComponent<K extends ComponentMeta["kind"]>(
  target: Class,
  kind: K,
  where: string,
): Extract<ComponentMeta, { kind: K }> {
  const meta = componentOf(target);
  if (meta?.kind !== kind) {
    throw new ComponentError({
      message: `${where}: ${target.name || "(anonymous class)"} is not a @${kindName[kind]} component`,
    });
  }
  return meta as Extract<ComponentMeta, { kind: K }>;
}

const kindName: Readonly<Record<ComponentMeta["kind"], string>> = {
  "pii-policy": "@PiiPolicy",
  guardrail: "@InputGuardrail / @OutputGuardrail",
  memory: "@Memory",
  mesh: "@Mesh",
  "tool-interceptor": "@ToolInterceptor",
  tool: "Tool",
  "mcp-server": "McpServer",
  "mcp-endpoint": "McpEndpoint",
  "a2a-endpoint": "A2AEndpoint",
  "a2a-agent": "A2AAgent",
  injectable: "Injectable",
  rag: "Rag",
  reranker: "RagReranker",
  judge: "Judge",
  channel: "Channel",
  "channel-selector": "ChannelSelector",
  "http-authenticator": "HttpAuthenticator",
  "file-policy": "FilePolicy",
  budget: "Budget",
  "health-check": "HealthCheck",
  observer: "Observer",
  "pause-listener": "PauseListener",
  "working-calendar": "WorkingCalendar",
  "database-storage": "DatabaseStorage",
  "cluster-storage": "ClusterStorage",
  "object-storage": "ObjectStorage",
};
