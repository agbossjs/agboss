import { recordOptionKeys } from "../components/option-keys.js";
import { A2A_ENDPOINT_KEYS } from "../components/decorator-options.js";
import type { Class } from "../components/injection.js";
import { recordComponent } from "../components/metadata.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { Milliseconds, Ttl } from "../units/index.js";

// #860: how a skill answers, defined beside the assembly rule that reads it (the root import
// loads the rule, never this decorator)
export { A2AReply } from "./a2a-message-skill-rule.js";
import type { A2AReply } from "./a2a-message-skill-rule.js";
// #904: how the card describes file fields, beside the rule that checks it
export { A2ACardFileFields } from "./files/a2a-file-options.js";
import type { A2ACardFileFields } from "./files/a2a-file-options.js";

/**
 * What the Agent Card says of one skill (#808): its tags and examples; its files (#859, #1316);
 * how it answers (#860).
 */
export interface A2AEndpointSkillOptions {
  /** Keywords of the skill; default the application's name. */
  readonly tags?: readonly string[];
  /** Example requests. */
  readonly examples?: readonly string[];
  /** A `@FilePolicy` that narrows its workflow's for this skill's files (#859, #1316): it may only tighten it. */
  readonly filePolicy?: Class;
  /** A task (`A2AReply.Task`, the default) or a direct message (`A2AReply.Message`, #860). */
  readonly reply?: A2AReply;
  /** How its card describes its file fields (#904), over the endpoint's `cardFileFields`. */
  readonly cardFileFields?: A2ACardFileFields;
}

/** A skill with options: the `@WorkflowStart` it runs and what its card says of it. */
export interface A2AEndpointSkill extends A2AEndpointSkillOptions {
  /** The `@WorkflowStart` class of one of the application's workflows: the skill's id is its name. */
  readonly start: Class;
}

/** One skill of an endpoint: a `@WorkflowStart` class, or one with options (`{ start, tags, … }`). */
export type A2ASkillEntry = Class | A2AEndpointSkill;

/**
 * How long an endpoint keeps what it serves (#1320): each endpoint sweeps its own rows, so two
 * endpoints on one workflow keep them for their own time.
 */
export interface A2AEndpointTtl {
  /**
   * A finished task after its last status change, and with it the ids of its messages: a message
   * resent within it gets the same task, never a second execution. `Ttl.Forever` keeps it for
   * ever; an unfinished task is never removed.
   */
  readonly tasks: Milliseconds | Ttl.Forever;
  /**
   * A direct message's reply (`A2AReply.Message`) after it was accepted, and with it its
   * `messageId`: a resend within it gets the same reply, the skill never runs twice. Above the
   * execution lease (30 s; `[a2a.ttl-invalid]`); the card publishes it.
   */
  readonly messages: Milliseconds;
}

/** `@A2AEndpoint({ name, version, description, ttl, skills, defaultSkill?, provider?, cardFileFields? })` (#1320). */
export interface A2AEndpointOptions {
  /** `billing` — kebab-case (`[name.not-kebab-case]`): the card's `name`. */
  readonly name: string;
  /** The contract's version: the card's `version`, in `describe --json` and federation checks. */
  readonly version: string;
  /** What the agent does: the card's `description`. */
  readonly description: string;
  /** How long it keeps its tasks and its direct messages' replies. */
  readonly ttl: A2AEndpointTtl;
  /**
   * The workflow starts it serves, one skill each, named by the start: a `@WorkflowStart` class, or
   * `{ start, tags?, examples?, filePolicy?, reply?, cardFileFields? }` for what its card says.
   */
  readonly skills: readonly A2ASkillEntry[];
  /**
   * The skill a message runs when it names none (#860) — a foreign caller that sends no
   * `metadata[A2A_SKILLS_EXTENSION].skill` to an agent of several skills; one of `skills`
   * (`[a2a.unknown-skill-option]`). Unset: with several skills a message must name one.
   */
  readonly defaultSkill?: Class;
  /** Who runs the agent: the card's `provider`. */
  readonly provider?: { readonly organization: string; readonly url: string };
  /**
   * How the card describes its skills' file fields (#904): out of the data `input` schema, in the
   * skills extension's `files` (`A2ACardFileFields.Extension`, the default), or in it as
   * `x-agboss-file-part` markers, never required (`A2ACardFileFields.Marker`); a skill may set its own.
   */
  readonly cardFileFields?: A2ACardFileFields;
}

/** What the endpoint component records: its options. */
export type A2AEndpointMeta = A2AEndpointOptions;

/** The `@WorkflowStart` of a skill entry. */
export const skillStartOf = (entry: A2ASkillEntry): Class =>
  typeof entry === "function" ? entry : entry.start;

/** The `@WorkflowStart`s an endpoint serves, in order. */
export const startsOfEndpoint = (endpoint: Pick<A2AEndpointOptions, "skills">): readonly Class[] =>
  endpoint.skills.map(skillStartOf);

/**
 * The skills' options by the start's name. What the card and the rules read a skill's tags, reply,
 * files by.
 */
export function skillMapOf(
  endpoint: Pick<A2AEndpointMeta, "skills">,
): Readonly<Record<string, A2AEndpointSkillOptions>> {
  const own = endpoint.skills.flatMap((entry): [string, A2AEndpointSkillOptions][] => {
    const name = typeof entry === "function" ? undefined : declarationOf(entry.start)?.options.name;
    return name === undefined || typeof entry === "function" ? [] : [[name, entry]];
  });
  return Object.fromEntries(own);
}

/** What the card-file-fields rules read of an endpoint: its own setting and its skills' by name. */
export const cardFileFieldsSourceOf = (
  endpoint: Pick<A2AEndpointMeta, "skills" | "cardFileFields">,
): {
  readonly cardFileFields?: A2ACardFileFields;
  readonly skills: Readonly<Record<string, A2AEndpointSkillOptions>>;
} => ({
  ...(endpoint.cardFileFields === undefined ? {} : { cardFileFields: endpoint.cardFileFields }),
  skills: skillMapOf(endpoint),
});

/** The options of the skill named `name` (its start's name), or none. */
export const skillOptionsOf = (
  endpoint: Pick<A2AEndpointMeta, "skills">,
  name: string,
): A2AEndpointSkillOptions | undefined => skillMapOf(endpoint)[name];

/**
 * `@A2AEndpoint` (mirrors `@McpEndpoint`) — what an application serves over A2A v1.0 (#808, #1320):
 * its Agent Card's name, version and description, how long it keeps what it serves, and the starts a
 * caller may run — one skill each, named by the start. Put it on an empty class, list it in
 * `@Application({ endpoints })` and serve it with `a2aHttpListener(app, { endpoint, publicUrl })`;
 * `agboss describe --json` lists it among the application's exported contracts.
 */
export function A2AEndpoint(options: A2AEndpointOptions) {
  return <C extends Class>(target: C): C => {
    recordOptionKeys(target, "A2AEndpoint", options, A2A_ENDPOINT_KEYS);
    recordComponent(target, { kind: "a2a-endpoint", meta: options satisfies A2AEndpointMeta });
    return target;
  };
}
