import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import type { AssemblyWarning, WarningSources } from "../application/start-log.js";
import {
  skillOptionsOf,
  startsOfEndpoint,
  type A2AEndpointMeta,
} from "./a2a-endpoint.decorator.js";
import { declarationOf } from "../flow/decorators/declaration.js";

/**
 * Two assembly warnings about what an application's A2A side says or hides (#812, design §4.4),
 * both read from the decorators:
 *
 * - `[a2a.skill-tags]`: an exported skill with no `tags` of its own. The card still carries one —
 *   the application's name — so it is only a warning: a caller that searches by tag finds nothing
 *   specific.
 * - `[a2a.unpriced-foreign-peer]`: an `@A2AAgent` without `target.application` (a peer that is not
 *   an AGBoss application) and without a `costPerCall` (every application has budgets). A foreign peer
 *   sends no run report, so its spend is invisible to those budgets unless the contract's price is
 *   charged.
 */

/** The skills of an `@A2AEndpoint` that name no tag of their own, by start name. */
function untaggedSkillsOf(meta: A2AEndpointMeta): readonly string[] {
  return startsOfEndpoint(meta).flatMap((start) => {
    const name = declarationOf(start)?.options.name;
    if (name === undefined) return [];
    const tags = skillOptionsOf(meta, name)?.tags;
    return tags === undefined || tags.length === 0 ? [name] : [];
  });
}

function skillTagWarnings(sources: WarningSources): AssemblyWarning[] {
  const application = sources.name ?? "the application";
  return (sources.endpoints ?? []).flatMap((expose) => {
    const component = componentOf(expose);
    if (component?.kind !== "a2a-endpoint") return [];
    const { meta } = component;
    return untaggedSkillsOf(meta).map((skill) => ({
      code: "a2a.skill-tags",
      message: `${meta.name} lists the skill ${skill} with no tags — its card says [${application}]; name some in @A2AEndpoint({ skills: [{ start: <the start>, tags }] })`,
    }));
  });
}

/** The `@A2AAgent`s listed anywhere in the application, each once. */
function a2aAgentsOf(sources: WarningSources): readonly Class[] {
  const listed = [
    ...sources.providers,
    ...(sources.modules ?? []).flatMap((module) => module.providers),
  ];
  const classes = listed.filter((provider): provider is Class => typeof provider === "function");
  return [...new Set(classes)].filter((cls) => componentOf(cls)?.kind === "a2a-agent");
}

function unpricedForeignWarnings(sources: WarningSources): AssemblyWarning[] {
  return a2aAgentsOf(sources).flatMap((agent): AssemblyWarning[] => {
    // the agent's price as the profiles leave it
    const meta = sources.componentOptions.a2aAgentMetaOf(agent);
    if (meta === undefined) return [];
    const { name, target, costPerCall } = meta;
    if (target?.application !== undefined || costPerCall !== undefined) return [];
    return [
      {
        code: "a2a.unpriced-foreign-peer",
        message: `${name} calls a peer that is not an AGBoss application and has no costPerCall — its spend is invisible to the application's budgets; set @A2AAgent({ costPerCall: usd(…) })`,
      },
    ];
  });
}

/** `[a2a.skill-tags]` and `[a2a.unpriced-foreign-peer]` of an application. */
export function a2aCardWarningsOf(sources: WarningSources): AssemblyWarning[] {
  return [...skillTagWarnings(sources), ...unpricedForeignWarnings(sources)];
}
