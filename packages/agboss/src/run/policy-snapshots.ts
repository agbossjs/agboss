import { isModelGuardrail, type LoadedGuardrail } from "../guardrails/loaded.js";
import type { AssembledToolInterceptors } from "../tool-interceptors/assembly.js";

/** What `configHash` hashes of a workflow's policies: its guardrails (#120) and tool interceptors (#384). */

/** What a workflow's tool interceptors are: each one's methods, each agent's chain per tool. */
export function toolInterceptorSnapshot(assembled: AssembledToolInterceptors | undefined): object {
  if (assembled === undefined || assembled.interceptors.length === 0) return {};
  const interceptors = assembled.interceptors.map(({ name, hooks }) => ({ name, ...hooks }));
  const chains = Object.fromEntries(
    [...assembled.byAgent].map(([agent, tools]) => [
      agent,
      Object.fromEntries([...tools].map(([tool, chain]) => [tool, chain.map((i) => i.name)])),
    ]),
  );
  return { toolInterceptors: { interceptors, chains } };
}

/** One guardrail as hashed: a model one's question, threshold and model; a code one's `decidedBy`. */
const guardrailEntryOf = (guardrail: LoadedGuardrail): object => {
  const { name, side, refusal } = guardrail;
  // a model guardrail keeps its shape before #383, so its workflow keeps its hash
  if (!isModelGuardrail(guardrail))
    return { name, side, decidedBy: guardrail.decidedBy, refusal: refusal ?? null };
  const { prompt, threshold, model } = guardrail;
  return { name, side, prompt, threshold, model, refusal: refusal ?? null };
};

/** What a workflow's guardrails decide with: their side, question, threshold, model and refusal. */
export const guardrailSnapshot = (guardrails: readonly LoadedGuardrail[]): object =>
  guardrails.length === 0 ? {} : { guardrails: guardrails.map(guardrailEntryOf) };
