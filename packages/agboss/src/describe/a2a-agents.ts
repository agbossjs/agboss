import type { AssembledApplication } from "../application/assemble.js";
import { componentOf } from "../components/metadata.js";
import { A2AMesh } from "../a2a/client/a2a-guard-errors.js";

/**
 * `agboss describe`'s A2A agents (#810 AC3, design §4.2): every `@A2AAgent` the application lists,
 * what it calls and whether the AGBoss mesh is guaranteed on its calls — `mesh: required` (an agent
 * without the extension is refused before anything is sent), or `mesh: not guaranteed (foreign
 * peer)` under `A2AMesh.IfSupported`: no loop, hop, budget or deadline protection beyond it, its
 * price the only spend charged.
 */

/** The mesh an agent's calls have, as described. */
const meshOf = (mesh: A2AMesh): string =>
  mesh === A2AMesh.Required ? "mesh: required" : "mesh: not guaranteed (foreign peer)";

/** The lines of the A2A agents section; none without an `@A2AAgent`. */
export function a2aAgentLines(assembled: AssembledApplication): string[] {
  const providers = new Set(assembled.modules.flatMap((module) => module.providers));
  const lines = [...providers].flatMap((provider): string[] => {
    const meta = typeof provider === "function" ? componentOf(provider) : undefined;
    if (meta?.kind !== "a2a-agent") return [];
    const { name, url, target } = meta.meta;
    const mesh =
      meta.meta.mesh ??
      (target?.application === undefined ? A2AMesh.IfSupported : A2AMesh.Required);
    const what =
      target?.application === undefined
        ? url
        : `${target.application}${target.skill === undefined ? "" : `/${target.skill}`}`;
    return [`  ${name} → ${what} · ${meshOf(mesh)}`];
  });
  return lines.length === 0 ? [] : ["a2a agents", ...lines];
}
