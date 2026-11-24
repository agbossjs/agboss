import { channelNameOf, isChannelRole } from "../channels/discovery.js";
import { implementationsOf } from "../channels/channel-rules.js";
import { pauseCalendarOf } from "../calendar/calendar-source.js";
import type { WorkingCalendarSource } from "../calendar/working-calendar.js";
import type { ChannelSender } from "../channels/channel-sender.js";
import type { PermitAnswer } from "../channels/pause-contexts.js";
import type { TimeSpan } from "../units/working-time.js";
import {
  pauseTargetOf,
  PauseRespondent,
  type PauseTargetOverlay,
} from "../channels/pause-targets.js";
import { channelRoleOf, PauseAnswerer } from "../channels/channel-role.decorator.js";
import type { ProviderModule } from "./container/registrations.js";
import type { Class } from "./injection.js";
import { componentOf } from "./metadata.js";
import { containerFor } from "./runtime.js";
import type { Container } from "./container/container.js";
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
import type { ModelResolver } from "../models/model-resolver.js";
import { codeClassesOf, type RuntimeGraph } from "../flow/runtime/graph-model.js";
import { NodeKind } from "../flow/ast.js";
import type { AssembledMemories } from "../memory/assembly.js";
import { customCompactionClassesOf } from "../memory/custom-classes.js";

/**
 * The channels of a workflow (#267): the classes its tools name, found from the graph — no
 * `channelClasses`. A role resolves to its one implementation in the application's providers
 * (by inheritance, like any contract); a concrete `@Channel` is used as is. One instance per
 * application: the container shares it with every workflow.
 */

/** The distinct channel classes the workflow's tools name, and the question roles it asks (#659). */
function channelClassesOf(tools: ToolClasses): readonly Class[] {
  const named = tools.local.flatMap((cls) => {
    const component = componentOf(cls);
    const channel = component?.kind === "tool" ? component.meta.channel : undefined;
    return channel === undefined ? [] : [channel];
  });
  return [...new Set([...named, ...(tools.questions ?? [])])];
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
  channelClassesOf(tools).flatMap((cls) => [
    ...(isChannelRole(cls) ? implementationsOf(cls, modules).slice(0, 1) : [cls]),
    // a role's own calendar class (#944): created by the container, its deps checked with the rest
    ...calendarClassOf(channelRoleOf(cls)?.options.workingCalendar),
  ]);

/** The class a calendar source is, if it is a class. */
const calendarClassOf = (source: WorkingCalendarSource | undefined): readonly Class[] =>
  typeof source === "function" ? [source] : [];

/**
 * Who may answer a channel's pauses: its role's `answerer`; a concrete `@Channel` named as is
 * (`TerminalUserChannel`) asks whoever runs the thread — its owner.
 */
const answererOf = (cls: Class): PauseAnswerer =>
  channelRoleOf(cls)?.options.answerer ?? PauseAnswerer.ThreadOwner;

/**
 * The target's `permitAnswer` bound to a target instance (#1307c): the target class created by the
 * container's tokens, its `deps` — at app start, so a missing dependency fails there. `undefined`
 * for a class that is no target or has no `permitAnswer`.
 */
function permitAnswerOf(cls: Class, container: Container): PermitAnswer | undefined {
  const declaration = pauseTargetOf(cls);
  const hook: unknown = Reflect.get(cls.prototype as object, "permitAnswer");
  if (declaration === undefined || typeof hook !== "function") return undefined;
  const args = (declaration.options.deps ?? []).map((dep) => container.get(dep));
  const holder: unknown = new (cls as unknown as new (...a: unknown[]) => unknown)(...args);
  return async (ctx) => (await Reflect.apply(hook, holder, [ctx])) as unknown;
}

/**
 * An owner's target no `@Channel` serves (#1307c): its pauses ask nobody and wait for the owner's
 * `app.resume`, so it has no sender.
 */
const isChannelless = (cls: Class, modules: readonly ProviderModule[]): boolean =>
  pauseTargetOf(cls)?.options.respondent === PauseRespondent.Owner &&
  implementationsOf(cls, modules).length === 0;

/** A target's deadline and reminder: a profile's over its own. */
const pauseTimesOf = (
  role: { readonly expiresIn?: TimeSpan; readonly remindBefore?: TimeSpan } | undefined,
  changed: PauseTargetOverlay | undefined,
) => ({
  expiresIn: changed?.timeout ?? role?.expiresIn,
  remindBefore: changed?.remindBefore ?? role?.remindBefore,
});

/** The workflow's channels by name (a role's name for a role), created by its container. */
export function channelPartsOf(
  bundle: WorkflowMeta,
  tools: ToolClasses,
  defaultCalendar?: WorkingCalendarSource,
  modules: readonly ProviderModule[] = [],
): Required<Pick<AssembledWorkflow, "channels">> {
  const channels = channelClassesOf(tools);
  return {
    channels: (services: WorkflowServices) =>
      new Map(
        channels.map((cls) => {
          const name = channelNameOf(cls);
          // the container gives a role's implementation (by inheritance): a channel, checked at assembly
          const container = containerFor(bundle, services);
          const sender = isChannelless(cls, modules)
            ? undefined
            : (container.get(cls) as ChannelSender);
          const permitAnswer = permitAnswerOf(cls, container);
          const role = channelRoleOf(cls)?.options;
          // a profile's deadline and reminder (`toolApprovals` / `externalTasks`) over the target's own
          const { expiresIn, remindBefore } = pauseTimesOf(role, bundle.pauseOverrides?.get(name));
          const workingCalendar = role?.workingCalendar;
          // a role's own calendar, else the application's: created by the application's container (#944)
          const calendar = pauseCalendarOf(workingCalendar ?? defaultCalendar, (one) =>
            container.get(one),
          );
          const channel = {
            name,
            sender,
            answerer: answererOf(cls),
            expiresIn,
            remindBefore,
            permitAnswer,
          };
          return [name, { ...channel, calendar }];
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
  owner: { readonly workingCalendar?: WorkingCalendarSource } | undefined,
  loader: PromptLoader,
  resolver?: ModelResolver,
): Promise<readonly AssembledReplyInterpreter[]> {
  // a workflow on its own is standalone; an application's calendar satisfies a working duration (#944)
  checkChannels(workflow, modules, owner === undefined, owner?.workingCalendar);
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

/** The question roles a workflow's flow asks (#659): its question steps' classes. */
export const questionRolesOf = (graph: Pick<RuntimeGraph, "nodes">): readonly Class[] =>
  [...graph.nodes.values()].flatMap((node) =>
    node.kind === NodeKind.Question ? [node.component] : [],
  );
