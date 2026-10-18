import type { McpServerConfig } from "../config/types.js";
import type { DtoClass } from "../dto/types.js";
import type { ServerTools } from "./mcp-client.js";
import type { Class, Token } from "./injection.js";
import type { ChannelMeta, PolicyFields } from "./meta-types.js";
import type { McpExposeOptions } from "../mcp/mcp-expose.decorator.js";

/** `@Tool` — its options as recorded, including the policy settings (`piiPolicies`, `guardrails`, …). */
export interface ToolMeta extends PolicyFields {
  readonly name: string;
  readonly description: string;
  readonly prompt?: string;
  readonly promptUrls?: readonly string[];
  readonly channel?: Class;
  readonly timeoutMs?: number;
  readonly input: DtoClass;
  readonly output: DtoClass;
  readonly deps: readonly Token[];
}

/** `@McpTool`: a tool whose server is among its dependencies. */
export interface McpToolMeta extends ToolMeta {
  readonly server: Class;
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
  | { readonly kind: "mcp-tool"; readonly meta: McpToolMeta }
  /** `@McpExpose` (`agboss/mcp`): what `createMcpService` exposes to MCP clients. */
  | { readonly kind: "mcp-expose"; readonly meta: McpExposeOptions }
  | { readonly kind: "channel"; readonly meta: ChannelMeta & { readonly deps: readonly Token[] } }
  | { readonly kind: "injectable"; readonly meta: { readonly deps: readonly Token[] } }
  | {
      readonly kind: "rag";
      readonly meta: {
        readonly name: string;
        readonly description: string;
        readonly prompt?: string;
        readonly promptUrls?: readonly string[];
        readonly topK: number;
        readonly deps: readonly Token[];
      };
    }
  /** `@PiiPolicy` (#120): declarative rules, or a project's own detector. */
  | {
      readonly kind: "pii-policy";
      readonly meta: import("../pii/pii-policy.decorator.js").PiiPolicyMeta;
    }
  | {
      readonly kind: "guardrail";
      readonly meta: { readonly name: string; readonly deps: readonly Token[] };
    }
  | {
      readonly kind: "judge";
      readonly meta: import("./judge-decorators.js").JudgeMeta & {
        readonly deps: readonly Token[];
      };
    }
  /** `@Budget` (#261): a money limit, listed in `@Application({ budgets })`. */
  | { readonly kind: "budget"; readonly meta: import("../budgets/budget.js").BudgetMeta }
  | {
      readonly kind: "a2a-agent";
      readonly meta: {
        readonly name: string;
        readonly url: string;
        readonly deps: readonly Token[];
      };
    };

/** Decorator metadata per class. Symbol.metadata is not available at runtime on Node 26. */
const components = new WeakMap<object, ComponentMeta>();

export const recordComponent = (target: object, meta: ComponentMeta): void => {
  components.set(target, meta);
};

export const componentOf = (target: object): ComponentMeta | undefined => components.get(target);

export class ComponentError extends Error {
  override name = "ComponentError";
}

export function requireComponent<K extends ComponentMeta["kind"]>(
  target: Class,
  kind: K,
  where: string,
): Extract<ComponentMeta, { kind: K }> {
  const meta = componentOf(target);
  if (meta?.kind !== kind) {
    throw new ComponentError(
      `${where}: ${target.name || "(anonymous class)"} is not a @${kindName[kind]} component`,
    );
  }
  return meta as Extract<ComponentMeta, { kind: K }>;
}

const kindName: Readonly<Record<ComponentMeta["kind"], string>> = {
  "pii-policy": "@PiiPolicy",
  guardrail: "@Guardrail",
  tool: "Tool",
  "mcp-server": "McpServer",
  "mcp-tool": "McpTool",
  "mcp-expose": "McpExpose",
  "a2a-agent": "A2AAgent",
  injectable: "Injectable",
  rag: "Rag",
  judge: "Judge",
  channel: "Channel",
  budget: "Budget",
};
