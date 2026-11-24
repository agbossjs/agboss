import type { FilePolicyMeta, FilePolicyOverlay, FileLimits } from "../files/file-policy.js";
import { filePolicyMetaOf, fileLimitsUnder, overlaidFilePolicyMeta } from "../files/file-policy.js";
import { declaredFilePolicyOf } from "../files/workflow-file-policy.js";
import type { ChannelOverlay } from "../config/overlay-types.js";
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
}

/** What `@Channel` records of a class: its options. */
export type ChannelMeta = Extract<ComponentMeta, { readonly kind: "channel" }>["meta"];

/** The classes the profiles give a workflow in place of its own, by workflow class. */
export interface OptionSlots {
  readonly filePolicy?: ReadonlyMap<Class, Class> | undefined;
}

export class ComponentOptions {
  /** What an assembly without profiles — or one that never named a shelf — carries: every class as declared. */
  static readonly none = new ComponentOptions();

  readonly #shelves: OptionShelves;
  readonly #slots: OptionSlots;

  constructor(shelves: OptionShelves = {}, slots: OptionSlots = {}) {
    this.#shelves = shelves;
    this.#slots = slots;
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
