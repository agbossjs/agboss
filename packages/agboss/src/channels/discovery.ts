import { withChildWorkflows, flowClassesOf } from "../flow/analyse/child-workflow.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { Class } from "../components/injection.js";
import { ComponentError, componentOf } from "../components/metadata.js";
import type { DtoClass } from "../dto/types.js";
import {
  channelRoleOf,
  channelRoleOptionsOf,
  type FoundChannelRole,
} from "./channel-role.decorator.js";

/**
 * Channels are found from the graph (#267 AC9), like services through `deps`: every tool of every
 * agent of the workflows and of the child workflows they launch names its channel — a concrete
 * `@Channel` (used as is) or a `@ChannelRole` (its implementation comes from the application).
 */

/** One tool that names a channel. */
export interface ChannelUse {
  /** The tool's `name`. */
  readonly tool: string;
  /** The tool's input DTO: what an approval role's `approves` must be. */
  readonly toolInput: DtoClass;
  /** The class the tool names: a role or a concrete channel. */
  readonly channel: Class;
  /** The workflow whose agent has the tool. */
  readonly workflow: string;
}

interface ToolChannel {
  readonly name: string;
  readonly input: DtoClass;
  readonly channel?: Class;
}

/** A tool class's name, input and channel; `undefined` for a class that is not a tool. */
function toolChannelOf(cls: Class): ToolChannel | undefined {
  const component = componentOf(cls);
  if (component?.kind !== "tool" && component?.kind !== "mcp-tool") return undefined;
  return component.meta;
}

/** The tools of the agents a workflow's flow names. */
function toolsOfWorkflow(workflow: Class): readonly Class[] {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== NodeKind.Workflow) return [];
  return flowClassesOf(declaration.options.flow).flatMap((node) => {
    const agent = declarationOf(node);
    return agent?.kind === NodeKind.Agent ? (agent.options.tools ?? []) : [];
  });
}

/** Every tool with a channel in the workflows and their children, each tool once per workflow. */
export function channelUsesOf(workflows: readonly Class[]): readonly ChannelUse[] {
  return withChildWorkflows(workflows).flatMap((workflow) => {
    const name = declarationOf(workflow)?.options.name ?? workflow.name;
    return [...new Set(toolsOfWorkflow(workflow))].flatMap((cls): readonly ChannelUse[] => {
      const tool = toolChannelOf(cls);
      if (tool?.channel === undefined) return [];
      return [{ tool: tool.name, toolInput: tool.input, channel: tool.channel, workflow: name }];
    });
  });
}

/** Whether the class is a `@ChannelRole` itself (abstract: its implementation is looked up). */
export const isChannelRole = (cls: Class): boolean => channelRoleOptionsOf(cls) !== undefined;

/** The name a channel class is known by: its role's (for a role) or its `@Channel` name. */
export function channelNameOf(cls: Class): string {
  const role = channelRoleOptionsOf(cls);
  if (role !== undefined) return role.name;
  const component = componentOf(cls);
  if (component?.kind === "channel") return component.meta.name;
  throw new ComponentError(
    `${cls.name || "(anonymous class)"} is named as a tool's channel but is neither a @Channel nor a @ChannelRole`,
  );
}

/** The roles the uses name (each once), with their options. */
export function rolesOf(uses: readonly ChannelUse[]): readonly FoundChannelRole[] {
  const found = new Map<Class, FoundChannelRole>();
  for (const use of uses) {
    const role = channelRoleOf(use.channel);
    if (role !== undefined) found.set(role.role, role);
  }
  return [...found.values()];
}
