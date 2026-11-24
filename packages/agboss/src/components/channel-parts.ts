import { channelsOf, checkChannels } from "../channels/channel-rules.js";
import { channelSelectorOf } from "../channels/channel-selector.js";
import { pauseCalendarOf } from "../calendar/calendar-source.js";
import type { ChannelSender } from "../channels/channel-sender.js";
import type { PermitAnswer, PermitReassign } from "../channels/pause-contexts.js";
import { pauseTargetOf, targetNameOf, type PauseTargetOverlay } from "../channels/pause-targets.js";
import type { ProviderModule } from "./container/registrations.js";
import type { Class } from "./injection.js";
import { componentOf } from "./metadata.js";
import { containerFor } from "./runtime.js";
import type { Container } from "./container/container.js";
import type { ToolClasses } from "./assemble-checks.js";
import type { WorkflowMeta } from "./meta-types.js";
import { optionsOf, type WorkflowPatch } from "./profiled.js";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";
import {
  codeInterpreterClassesOf,
  replyInterpretersOf,
  type AssembledReplyInterpreter,
} from "../channels/discovery.js";
import type { PromptLoader } from "./prompt-render.js";
import type { ModelResolver } from "../models/model-resolver.js";
import { codeClassesOf, type RuntimeGraph } from "../flow/runtime/graph-model.js";
import { NodeKind } from "../flow/ast.js";
import type { AssembledMemories } from "../memory/assembly.js";
import { customCompactionClassesOf } from "../memory/custom-classes.js";
import type { PauseChannel, PauseTarget } from "../flow/runtime/pause-channel.js";
import type { TimeSpan } from "../units/working-time.js";

/**
 * The pause targets of a workflow (#267, #1307): the `@ToolApproval`s its tools name, the
 * `@ExternalTask`s its flow and agents ask, and the targets they may escalate to — found from the
 * graph. The `@Channel`s that serve them come from the application's `channels` (found by their
 * `target`), created by its container; a target with several has its `@ChannelSelector`. One
 * instance of each per application: the container shares it with every workflow.
 */

/** The distinct pause targets the workflow names, and every target they escalate to. */
function targetClassesOf(tools: ToolClasses): readonly Class[] {
  const named = tools.local.flatMap((cls) => {
    const component = componentOf(cls);
    const approval = component?.kind === "tool" ? component.meta.approval : undefined;
    return approval === undefined ? [] : [approval];
  });
  const found = new Set<Class>([...named, ...(tools.questions ?? [])]);
  for (const cls of found) {
    for (const to of pauseTargetOf(cls)?.options.escalatesTo ?? []) found.add(to);
  }
  return [...found];
}

/** The calendar class of a target, if it names one. */
const calendarClassOf = (calendar: Class | undefined): readonly Class[] =>
  calendar === undefined ? [] : [calendar];

/**
 * The classes the container creates for the pause targets, for the dependency graph check: the
 * channels that serve them (their `deps`), their selectors, their calendars. A target that needs a
 * channel and has none is reported by the channel rules, not here.
 */
export const channelComponentClassesOf = (
  tools: ToolClasses,
  modules: readonly ProviderModule[],
): Class[] =>
  targetClassesOf(tools).flatMap((target) => [
    ...channelsOf(target, modules),
    ...selectorsOf(target, modules),
    ...calendarClassOf(pauseTargetOf(target)?.options.calendar),
  ]);

/** The listed `@ChannelSelector`s of a target. */
const selectorsOf = (target: Class, modules: readonly ProviderModule[]): readonly Class[] =>
  modules.flatMap((module) =>
    module.providers.filter(
      (provider): provider is Class =>
        typeof provider === "function" && channelSelectorOf(provider)?.target === target,
    ),
  );

/**
 * The target's hook bound to a target instance (#1307c): the target class created by the
 * container's tokens, its `deps` — at app start, so a missing dependency fails there. `undefined`
 * for a hook the target does not have.
 */
function hookOf(
  cls: Class,
  holder: unknown,
  name: "permitAnswer" | "permitReassign",
): ((ctx: never) => Promise<unknown>) | undefined {
  const hook: unknown = Reflect.get(cls.prototype as object, name);
  if (typeof hook !== "function") return undefined;
  return async (ctx) => (await Reflect.apply(hook, holder, [ctx])) as unknown;
}

/** The one instance of a target class: its `deps` from the container. */
function instanceOf(cls: Class, container: Container): unknown {
  const declaration = pauseTargetOf(cls);
  const args = (declaration?.options.deps ?? []).map((dep) => container.get(dep));
  return Reflect.construct(cls, args);
}

/** A target's deadline and reminder: a profile's over its own. */
const pauseTimesOf = (
  options: { readonly timeout?: TimeSpan; readonly remindBefore?: TimeSpan },
  changed: PauseTargetOverlay | undefined,
) => ({
  timeout: changed?.timeout ?? options.timeout,
  remindBefore: changed?.remindBefore ?? options.remindBefore,
});

/** A channel instance as a pause asks it: its name from its own `@Channel`. */
function pausedChannelOf(cls: Class, sender: ChannelSender): PauseChannel {
  const meta = componentOf(cls);
  const name = meta?.kind === "channel" ? meta.meta.name : cls.name;
  return { name, cls, sender };
}

/**
 * The channels of one target by name, created by `container`. A target with one channel resolves
 * through its own token — the one listed channel, or the class a test's `services` put in its
 * place; several (a `@ChannelSelector` picks) are created by their classes.
 */
function channelsOfTarget(
  target: Class,
  modules: readonly ProviderModule[],
  container: Container,
): ReadonlyMap<string, PauseChannel> {
  const listed = channelsOf(target, modules);
  if (listed.length === 1) {
    const sender = container.get(target) as ChannelSender;
    const channel = pausedChannelOf(sender.constructor as Class, sender);
    return new Map([[channel.name, channel]]);
  }
  return new Map(
    listed.map((cls) => {
      const channel = pausedChannelOf(cls, container.get(cls) as ChannelSender);
      return [channel.name, channel];
    }),
  );
}

/** The workflow's pause targets by name, created by its container. */
export function channelPartsOf(
  bundle: WorkflowMeta,
  tools: ToolClasses,
  modules: readonly ProviderModule[] = [],
): Required<Pick<AssembledWorkflow, "pauseTargets">> {
  const targets = targetClassesOf(tools);
  return {
    pauseTargets: (services: WorkflowServices) =>
      new Map(
        targets.map((cls) => {
          const options = pauseTargetOf(cls)?.options;
          if (options === undefined) throw new TypeError(`${targetNameOf(cls)} is no pause target`);
          const container = containerFor(bundle, services);
          const holder = instanceOf(cls, container);
          const channels = channelsOfTarget(cls, modules, container);
          const [selector] = selectorsOf(cls, modules);
          const select =
            selector === undefined
              ? undefined
              : async (ctx: never): Promise<Class> => {
                  const instance = container.get(selector) as {
                    selectChannel(ctx: never): Class | Promise<Class>;
                  };
                  return instance.selectChannel(ctx);
                };
          // a profile's deadline and reminder (`toolApprovals` / `externalTasks`) over the target's own
          const { timeout, remindBefore } = pauseTimesOf(
            options,
            bundle.pauseOverrides?.get(options.name),
          );
          const calendar = pauseCalendarOf(options.calendar, (one) => container.get(one));
          const target: PauseTarget = {
            name: options.name,
            cls,
            kind: options.output === undefined ? "tool-approval" : "external-task",
            respondent: options.respondent,
            channels,
            select,
            timeout,
            remindBefore,
            calendar,
            escalationLimits: options.escalationLimits,
            permitAnswer: hookOf(cls, holder, "permitAnswer") as PermitAnswer | undefined,
            permitReassign: hookOf(cls, holder, "permitReassign") as PermitReassign | undefined,
          };
          return [options.name, target];
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
  owner: { readonly patch?: WorkflowPatch } | undefined,
  loader: PromptLoader,
  resolver?: ModelResolver,
): Promise<readonly AssembledReplyInterpreter[]> {
  // a workflow on its own is standalone
  checkChannels(workflow, modules, optionsOf(owner?.patch), owner === undefined);
  return replyInterpretersOf(workflow, loader, resolver);
}

/**
 * The classes the container creates for a workflow's code: its nodes', PII detectors',
 * interpreters' and custom compactions' (#382).
 */
export const createdClassesOf = (
  graph: Pick<RuntimeGraph, "nodes" | "launches">,
  piiClasses: readonly Class[],
  interpreters: readonly AssembledReplyInterpreter[],
  memories?: AssembledMemories,
): Class[] => [
  ...codeClassesOf(graph),
  ...piiClasses,
  ...codeInterpreterClassesOf(interpreters),
  ...customCompactionClassesOf(memories),
];

/** The external tasks a workflow's flow asks (#659): its steps' classes. */
export const questionRolesOf = (graph: Pick<RuntimeGraph, "nodes">): readonly Class[] =>
  [...graph.nodes.values()].flatMap((node) =>
    node.kind === NodeKind.Question ? [node.component] : [],
  );
