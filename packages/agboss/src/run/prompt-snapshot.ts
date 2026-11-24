import type { AssembledReplyInterpreter } from "../channels/discovery.js";
import type { LoadedModelGuardrail } from "../guardrails/loaded.js";
import { normalisePromptText } from "../components/prompt-render.js";

/**
 * The model reply interpreters' rendered instructions (#1347c), only where there is one: a workflow
 * without a model interpreter keeps its hash.
 */
export const interpreterPrompts = (
  interpreters: readonly AssembledReplyInterpreter[] | undefined,
): { readonly replyInterpreters?: readonly object[] } => {
  const model = (interpreters ?? [])
    .filter((found) => found.model !== undefined)
    .map(({ channel, name, instructions }) => ({
      channel,
      name,
      prompt: normalisePromptText(instructions),
    }))
    .sort((left, right) => left.channel.localeCompare(right.channel));
  return model.length === 0 ? {} : { replyInterpreters: model };
};

/** The model rerankers' prompts (#1347) in the prompt version, only where one has a prompt. */
export const rerankerPrompts = (
  rerankers: readonly { readonly name: string; readonly prompt?: string }[] | undefined,
): { readonly rerankers?: readonly object[] } => {
  const prompted = (rerankers ?? [])
    .filter((found) => (found.prompt ?? "") !== "")
    .map(({ name, prompt }) => ({ name, prompt: normalisePromptText(prompt ?? "") }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return prompted.length === 0 ? {} : { rerankers: prompted };
};

/** The guardrails' questions (#120) in the prompt version; the key `guards` keeps the versions of workflows without them. */
export const guardrailPrompts = (guardrails: readonly LoadedModelGuardrail[]): object => ({
  guards: guardrails.map(({ name, side, prompt, threshold }) => ({
    name,
    side,
    prompt,
    threshold,
  })),
});

/** The guardrails' models in the model version, only where there is one. */
export const guardrailModels = (guardrails: readonly LoadedModelGuardrail[]): object =>
  guardrails.length === 0
    ? {}
    : { guardrails: guardrails.map(({ name, model }) => ({ name, model })) };
