import type { Class } from "../components/injection.js";
import { recordComponent } from "../components/metadata.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { hours, minutes } from "../units/index.js";
import type {
  A2AEndpointMeta,
  A2AEndpointSkillOptions,
  A2AEndpointTtl,
  A2ASkillEntry,
} from "./a2a-endpoint.decorator.js";
import type { A2ACardFileFields } from "./files/a2a-file-options.js";

// kept for the importers that still take them from here: the rules and the card read them
export { A2AReply } from "./a2a-message-skill-rule.js";
export { A2ACardFileFields } from "./files/a2a-file-options.js";

/** The skill options of the old form, keyed by the start's name. */
export type A2AExposedSkillOptions = A2AEndpointSkillOptions;

/**
 * `@A2AExpose`'s options (#398 PR 3, #808): the form of 0.1.0 — `exports` and a `skills` map by start name.
 * `@A2AEndpoint` replaces it (#1320); this form stays only until the test sweep flips its users.
 */
export interface A2AExposeOptions {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly exports: readonly Class[];
  readonly skills?: Readonly<Record<string, A2AEndpointSkillOptions>>;
  readonly defaultSkill?: Class;
  readonly cardFileFields?: A2ACardFileFields;
  readonly provider?: { readonly organization: string; readonly url: string };
  /** How long it keeps what it serves; default `hours(24)` for tasks, `minutes(15)` for messages. */
  readonly ttl?: A2AEndpointTtl;
}

/** `@A2AExpose`'s options as an endpoint's: the old form's skills map folded into its entries. */
function endpointMetaOf(options: A2AExposeOptions): A2AEndpointMeta {
  const named = options.skills ?? {};
  const matched = new Set<string>();
  const skills = options.exports.map((start): A2ASkillEntry => {
    const name = declarationOf(start)?.options.name;
    const own = name === undefined ? undefined : named[name];
    if (name === undefined || own === undefined) return start;
    matched.add(name);
    return { ...own, start };
  });
  const unmatched = Object.entries(named).filter(([name]) => !matched.has(name));
  return {
    name: options.name,
    version: options.version,
    description: options.description,
    ttl: options.ttl ?? { tasks: hours(24), messages: minutes(15) },
    skills,
    ...(options.defaultSkill === undefined ? {} : { defaultSkill: options.defaultSkill }),
    ...(options.cardFileFields === undefined ? {} : { cardFileFields: options.cardFileFields }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(unmatched.length === 0 ? {} : { unmatchedSkills: Object.fromEntries(unmatched) }),
  };
}

/**
 * `@A2AExpose` — the form of 0.1.0, recorded as an `@A2AEndpoint`: its `exports` and `skills` map are
 * the endpoint's `skills` list. Removed with the flip of its users (#1320, F2).
 */
export function A2AExpose(options: A2AExposeOptions) {
  return <C extends Class>(target: C): C => {
    recordComponent(target, { kind: "a2a-endpoint", meta: endpointMetaOf(options) });
    return target;
  };
}
