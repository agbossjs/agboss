import { channelNameOf, isChannelRole } from "../channels/discovery.js";
import { implementationsOf } from "../channels/channel-rules.js";
import type { ChannelSender } from "../channels/channel-sender.js";
import { channelRoleOf, PauseAnswerer } from "../channels/channel-role.decorator.js";
import type { ProviderModule } from "./container/registrations.js";
import type { Class } from "./injection.js";
import { componentOf } from "./metadata.js";
import { containerFor } from "./runtime.js";
import type { ToolClasses } from "./assemble-checks.js";
import type { WorkflowMeta } from "./meta-types.js";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";
import { checkChannels } from "../channels/channel-rules.js";
import {
  codeInterpreterClassesOf,
  replyInterpretersOf,
  type AssembledReplyInterpreter,
} from "../channels/discovery.js";
import type { PromptLoader } from "./prompt-render.js";
import { codeClassesOf, type RuntimeGraph } from "../flow/runtime/graph-model.js";

/**
 * The channels of a workflow (#267): the classes its tools name, found from the graph — no
 * `channelClasses`. A role resolves to its one implementation in the application's providers
 * (by inheritance, like any contract); a concrete `@Channel` is used as is. One instance per
 * application: the container shares it with every workflow.
 */

/** The distinct channel classes the workflow's tools name. */
function channelClassesOf(tools: ToolClasses): readonly Class[] {
  const named = [...tools.local, ...tools.mcp].flatMap((cls) => {
    const component = componentOf(cls);
    const channel =
      component?.kind === "tool" || component?.kind === "mcp-tool"
        ? component.meta.channel
        : undefined;
    return channel === undefined ? [] : [channel];
  });
  return [...new Set(named)];
}

/**
 * The classes the container creates for the channels, for the dependency graph check: a role's
 * implementation (its `deps`), a concrete channel itself. A role without exactly one implementation
 * is reported by the channel rules, not here.
 */
export const channelComponentClassesOf = (
  tools: ToolClasses,
  modules: readonly ProviderModule[],
): Class[] =>
  channelClassesOf(tools).flatMap((cls) =>
    isChannelRole(cls) ? implementationsOf(cls, modules).slice(0, 1) : [cls],
  );

/**
 * Who may answer a channel's pauses: its role's `answeredBy`; a concrete `@Channel` named as is
 * (`TerminalUserChannel`) asks whoever runs the thread — its owner.
 */
const answeredByOf = (cls: Class): PauseAnswerer =>
  channelRoleOf(cls)?.options.answeredBy ?? PauseAnswerer.ThreadOwner;

/** The workflow's channels by name (a role's name for a role), created by its container. */
export function channelPartsOf(
  bundle: WorkflowMeta,
  tools: ToolClasses,
): Required<Pick<AssembledWorkflow, "channels">> {
  const channels = channelClassesOf(tools);
  return {
    channels: (services: WorkflowServices) =>
      new Map(
        channels.map((cls) => {
          const name = channelNameOf(cls);
          // the container gives a role's implementation (by inheritance): a channel, checked at assembly
          const sender = containerFor(bundle, services).get(cls) as ChannelSender;
          return [name, { name, sender, answeredBy: answeredByOf(cls) }];
        }),
      ),
  };
}

/**
 * The channels of a workflow checked (its children's too) and its tree's reply interpreters
 * (#267 PR 3), a model one's instructions loaded by `loader` (its problems reported with the rest).
 */
export async function checkedChannelsOf(
  workflow: Class,
  modules: readonly ProviderModule[],
  isStandalone: boolean,
  loader: PromptLoader,
): Promise<readonly AssembledReplyInterpreter[]> {
  checkChannels(workflow, modules, isStandalone);
  return replyInterpretersOf(workflow, loader);
}

/** The classes the container creates for a workflow's code: its nodes', PII detectors', interpreters'. */
export const createdClassesOf = (
  graph: Pick<RuntimeGraph, "nodes" | "launches">,
  piiClasses: readonly Class[],
  interpreters: readonly AssembledReplyInterpreter[],
): Class[] => [...codeClassesOf(graph), ...piiClasses, ...codeInterpreterClassesOf(interpreters)];
