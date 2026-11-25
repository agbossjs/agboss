/** Stable codes of a model setting that cannot work (startup and `agboss check --models`). */
export type ModelProblemCode =
  | "model.missing-provider"
  | "model.incompatible-provider"
  | "model.duplicate-provider-name"
  | "model.missing"
  | "model.unknown-model"
  | "model.unsupported-setting"
  | "model.no-price"
  | "model.fallback-no-price"
  | "model.no-matching-endpoint"
  | "model.unsupported-input";

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
