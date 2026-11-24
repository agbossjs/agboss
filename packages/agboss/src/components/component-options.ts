import type { FilePolicyMeta, FilePolicyOverlay, FileLimits } from "../files/file-policy.js";
import { filePolicyMetaOf, fileLimitsUnder, overlaidFilePolicyMeta } from "../files/file-policy.js";
import { declaredFilePolicyOf } from "../files/workflow-file-policy.js";
import type { A2AAgentMeta } from "../a2a/a2a-decorator.js";
import type { A2AEndpointMeta } from "../a2a/a2a-endpoint.decorator.js";
import type {
  A2AAgentOverlay,
  A2AEndpointOverlay,
  ChannelOverlay,
  McpServerOverlay,
} from "../config/overlay-types.js";
import type { ChildPlacement } from "../flow/child-placement.js";
import {
  declaredExecutionLimitsOf,
  declaredHistoryTtlOf,
  type ExecutionLimitsOf,
  type WorkflowExecutionLimits,
} from "../flow/decorators/workflow.js";
import type { Milliseconds, Ttl } from "../units/index.js";
import type { Class } from "./injection.js";
import { componentOf, type ComponentMeta } from "./metadata.js";

/**
 * The options of the application's components as the selected profiles leave them (#1318c): ONE carrier
 * per assembly, like the budget overlays. A component class stays its own identity — nothing derives a
 * subclass, nothing declared is changed — and every reader asks this carrier for the class's effective
 * options, so a limit is the same on every path that reads it. Two assemblies of one application under
 * two profiles hold two carriers and never see each other.
 *
 * What a profile can name: shelves by component `name`, and the classes a profile gives one workflow in
 * place of its own (slots, by workflow class).
 */

/** The shelves of the selected profiles, folded left to right: each by the component's `name`. */
export interface OptionShelves {
  readonly filePolicies?: Readonly<Record<string, FilePolicyOverlay>> | undefined;
  readonly channels?: Readonly<Record<string, ChannelOverlay>> | undefined;
  readonly a2aEndpoints?: Readonly<Record<string, A2AEndpointOverlay>> | undefined;
  readonly a2aAgents?: Readonly<Record<string, A2AAgentOverlay>> | undefined;
  readonly mcpServers?: Readonly<Record<string, McpServerOverlay>> | undefined;
}

/** What `@McpServer` records of a class: its name, its connection and its declared tools. */
export type McpServerMeta = Extract<ComponentMeta, { readonly kind: "mcp-server" }>["meta"];

/** What `@Channel` records of a class: its options. */
export type ChannelMeta = Extract<ComponentMeta, { readonly kind: "channel" }>["meta"];

/** The classes the profiles give a workflow in place of its own, by workflow class. */
export interface OptionSlots {
  readonly filePolicy?: ReadonlyMap<Class, Class> | undefined;
  /** Where each child workflow runs under the profiles, by workflow class: over its declaration and the default. */
  readonly placement?: ReadonlyMap<Class, ChildPlacement> | undefined;
  /** What a profile changes of each workflow's `executionLimits`, field by field, by workflow class. */
  readonly executionLimits?: ReadonlyMap<Class, WorkflowExecutionLimits> | undefined;
  /** How long a profile keeps each workflow's history, over its `@Workflow({ historyTtl })`, by workflow class. */
  readonly historyTtl?: ReadonlyMap<Class, Milliseconds | Ttl> | undefined;
}

const NO_PLACEMENTS: ReadonlyMap<Class, ChildPlacement> = new Map();

export class ComponentOptions {
  /** What an assembly without profiles — or one that never named a shelf — carries: every class as declared. */
  static readonly none = new ComponentOptions();

  readonly #shelves: OptionShelves;
  readonly #slots: OptionSlots;

  constructor(shelves: OptionShelves = {}, slots: OptionSlots = {}) {
    this.#shelves = shelves;
    this.#slots = slots;
  }

  /** Where each child workflow runs under the profiles (`workflows.<name>.placement`); none for a profile that sets none. */
  get placements(): ReadonlyMap<Class, ChildPlacement> {
    return this.#slots.placement ?? NO_PLACEMENTS;
  }

  /**
   * A workflow's `executionLimits` as the profiles leave them: each limit its profile sets over the
   * one its `@Workflow({ executionLimits })` declares. The run, the assembly rules, the worst case
   * and `describe` all read the limits here, so a limit is the same on every path.
   */
  readonly executionLimitsOf: ExecutionLimitsOf = (workflow) => {
    const declared = declaredExecutionLimitsOf(workflow);
    const overlay = this.#slots.executionLimits?.get(workflow);
    return overlay === undefined ? declared : { ...declared, ...overlay };
  };

  /** How long a workflow's history is kept: its profile's `historyTtl` over its `@Workflow({ historyTtl })`. */
  historyTtlOf(workflow: Class): Milliseconds | Ttl | undefined {
    return this.#slots.historyTtl?.get(workflow) ?? declaredHistoryTtlOf(workflow);
  }

  /** The `@FilePolicy` of a workflow: its profile's slot over its `@Workflow({ filePolicy })`. */
  workflowFilePolicy(workflow: Class | undefined): Class | undefined {
    if (workflow === undefined) return undefined;
    return this.#slots.filePolicy?.get(workflow) ?? declaredFilePolicyOf(workflow);
  }

  /** A `@FilePolicy` class's options with its shelf's overlay on top. */
  readonly filePolicyMetaOf = (policy: Class): FilePolicyMeta | undefined => {
    const meta = filePolicyMetaOf(policy);
    return meta === undefined
      ? undefined
      : overlaidFilePolicyMeta(meta, this.#shelves.filePolicies?.[meta.name]);
  };

  /** A `@Channel` class's options with its shelf's overlay on top; `undefined` for a class that is none. */
  channelMetaOf(channel: Class): ChannelMeta | undefined {
    const component = componentOf(channel);
    if (component?.kind !== "channel") return undefined;
    const overlay = this.#shelves.channels?.[component.meta.name];
    return overlay === undefined ? component.meta : { ...component.meta, ...overlay };
  }

  /** An `@A2AEndpoint` class's options with its shelf's overlay on top (`ttl` field by field); `undefined` for a class that is none. */
  a2aEndpointMetaOf(endpoint: Class): A2AEndpointMeta | undefined {
    const component = componentOf(endpoint);
    if (component?.kind !== "a2a-endpoint") return undefined;
    const overlay = this.#shelves.a2aEndpoints?.[component.meta.name];
    return overlay === undefined
      ? component.meta
      : { ...component.meta, ttl: { ...component.meta.ttl, ...overlay.ttl } };
  }

  /** An `@A2AAgent` class's options with its shelf's overlay on top; `undefined` for a class that is none. */
  a2aAgentMetaOf(agent: Class): A2AAgentMeta | undefined {
    const component = componentOf(agent);
    if (component?.kind !== "a2a-agent") return undefined;
    const overlay = this.#shelves.a2aAgents?.[component.meta.name];
    return overlay === undefined ? component.meta : { ...component.meta, ...overlay };
  }

  /** An `@McpServer` class's options with its shelf's overlay on top of its connection; `undefined` for a class that is none. */
  mcpServerMetaOf(server: Class): McpServerMeta | undefined {
    const component = componentOf(server);
    if (component?.kind !== "mcp-server") return undefined;
    const overlay = this.#shelves.mcpServers?.[component.meta.name];
    return overlay === undefined
      ? component.meta
      : {
          ...component.meta,
          config: { ...component.meta.config, ...overlay } as McpServerMeta["config"],
        };
  }

  /** The limits of a chain of policies, the outermost first, every overlay applied. */
  fileLimits(...chain: readonly (Class | undefined)[]): FileLimits {
    return fileLimitsUnder(this.filePolicyMetaOf, ...chain);
  }

  /** The limits of a workflow's files, then of a narrower policy's (a skill's) over them. */
  workflowFileLimits(
    workflow: Class | undefined,
    ...narrower: readonly (Class | undefined)[]
  ): FileLimits {
    return this.fileLimits(this.workflowFilePolicy(workflow), ...narrower);
  }
}
