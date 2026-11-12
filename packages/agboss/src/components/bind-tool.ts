import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { Class } from "./injection.js";
import { componentOf, ComponentError } from "./metadata.js";

export interface BindToolOptions {
  agent?: Class | string;
}

export interface BoundToolConfig {
  methodName: string;
  agent?: string;
}

const boundTools = new WeakMap<object, Record<string, BoundToolConfig[]>>();

export const getBoundTools = (target: object): Record<string, BoundToolConfig[]> => {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  return boundTools.get(target) || {};
};

export function BindTool(tool: Class, options?: BindToolOptions): MethodDecorator;
// eslint-disable-next-line @typescript-eslint/unified-signatures
export function BindTool(toolName: string, options?: BindToolOptions): MethodDecorator;
export function BindTool(tool: Class | string, options?: BindToolOptions) {
  // eslint-disable-next-line complexity, @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
  return function (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
    let toolName: string;
    if (typeof tool === "string") {
      toolName = tool;
    } else {
      const meta = componentOf(tool);
      if (meta?.kind !== "tool" && meta?.kind !== "mcp-tool") {
        throw new ComponentError({ message: "@BindTool expects a @Tool, @McpTool, or a string" });
      }
      toolName = meta.meta.name;
    }

    let agentName: string | undefined;
    if (options?.agent) {
      if (typeof options.agent === "string") {
        agentName = options.agent;
      } else {
        const agentDeclaration = declarationOf(options.agent);
        if (agentDeclaration?.kind !== NodeKind.Agent) {
          throw new ComponentError({
            message: "@BindTool agent option expects an @Agent or a string",
          });
        }
        agentName = agentDeclaration.options.name;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/prefer-nullish-coalescing
    const handlers = boundTools.get(target) || {};
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    if (!handlers[toolName]) {
      handlers[toolName] = [];
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    handlers[toolName]!.push({ methodName: propertyKey as string, agent: agentName });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    boundTools.set(target, handlers);
  };
}
