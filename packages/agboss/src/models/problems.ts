import { AGBossError } from "../core/errors.js";
/** Stable codes of a model setting that cannot work (startup and `agboss check --models`). */
export type ModelProblemCode =
  | "model.unserved"
  | "model.ambiguous-provider"
  | "model.unknown-model"
  | "model.unsupported-setting"
  | "model.no-price"
  | "model.fallback-unmapped"
  | "model.fallback-no-price"
  | "model.no-matching-endpoint";

/** One problem: the setting's key, its value, the model and what the model supports. */
export interface ModelProblem {
  readonly code: ModelProblemCode;
  readonly key: string;
  readonly value: string;
  readonly model: string;
  readonly supported: string;
}

export const problemLine = (problem: ModelProblem): string =>
  `${problem.code}  ${problem.key} = ${problem.value} — model ${problem.model}: ${problem.supported}`;

/** What a model-settings error takes (#906): every problem found. */
export interface ConfigurationErrorOptions {
  readonly problems: readonly ModelProblem[];
  readonly cause?: unknown;
}

/** Every model setting that cannot work, all at once — raised before any model call. */
export class ConfigurationError extends AGBossError {
  static override readonly code = "config.model-settings" as const;
  declare readonly code: typeof ConfigurationError.code;
  override name = "ConfigurationError";
  readonly problems: readonly ModelProblem[];

  constructor(options: ConfigurationErrorOptions) {
    const { problems, cause } = options;
    super(
      `${String(problems.length)} model setting(s) do not fit their models:\n${problems
        .map((problem) => `  ${problemLine(problem)}`)
        .join("\n")}`,
      { cause },
    );
    this.problems = problems;
  }
}
