import { ConfigError } from "../core/error-families/config-errors.js";
import type { EnvRef } from "../environments/env-ref.js";
import { resolveReferences } from "../environments/define-env.js";
import { OptionalSecretReference, Secret } from "../environments/secret.js";
import { VariableReference } from "../environments/variables.js";
import type { PromptProblem } from "./prompt-problems.js";

/**
 * The static `{{key}}` values of prompts (#1347c): a text, or an `EnvRef<string>` from `defineEnv`
 * (`appEnv.companyName`), read once when the application is assembled. A `SecretRef` is no value:
 * a secret never reaches a prompt, so it does not type-check here and fails assembly in untyped code.
 */
export type PromptVariables = Readonly<Record<string, string | EnvRef<string>>>;

/** The variables of one level as texts; a key whose value is a problem has `undefined`. */
export type ResolvedPromptVariables = Readonly<Record<string, string | undefined>>;

const isSecretLike = (value: unknown): boolean =>
  value instanceof Secret || value instanceof OptionalSecretReference;

/** One variable as its text, or the problem with it (naming the key and the process variable, never a value). */
function textOf(
  where: string,
  key: string,
  value: unknown,
  env: NodeJS.ProcessEnv,
): { readonly text?: string; readonly problem?: PromptProblem } {
  const name = `${where}.${key}`;
  if (typeof value === "string") return { text: value };
  if (isSecretLike(value))
    return {
      problem: {
        code: "prompt.secret-in-instructions",
        message: `${name} is a secret reference — a secret never reaches a prompt or a model; pass the text a prompt may show (an env(…) reference or a literal)`,
      },
    };
  if (!(value instanceof VariableReference))
    return {
      problem: {
        code: "prompt.invalid-variable",
        message: `${name} is not a text or an env(…) reference`,
      },
    };
  try {
    const resolved = resolveReferences({ [key]: value }, env, where)[key];
    if (typeof resolved === "string") return { text: resolved };
    return {
      problem: {
        code: "prompt.invalid-variable",
        message: `${name} reads ${value.variable}, which is not a text`,
      },
    };
  } catch (error) {
    if (!(error instanceof ConfigError.Environment)) throw error;
    return { problem: { code: "prompt.invalid-variable", message: `${name}: ${error.message}` } };
  }
}

/**
 * The variables of one level (`where` = `@Workflow "x" promptVariables`) as texts, every `env(…)`
 * reference read from `env`; every problem is pushed to `problems` — nothing but a text is ever
 * returned, so no secret can be rendered.
 */
export function resolvedPromptVariables(
  where: string,
  variables: Readonly<Record<string, unknown>> | undefined,
  env: NodeJS.ProcessEnv,
  problems: PromptProblem[],
): ResolvedPromptVariables {
  const entries = Object.entries(variables ?? {}).map(([key, value]) => {
    const { text, problem } = textOf(where, key, value, env);
    if (problem !== undefined) problems.push(problem);
    return [key, text] as const;
  });
  return Object.fromEntries(entries);
}
