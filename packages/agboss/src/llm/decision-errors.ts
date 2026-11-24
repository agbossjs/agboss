import { AGBossError } from "../core/errors.js";

/** What a model can do (#269): chat (`invoke`) or decide (`decide`). */
export enum ModelKind {
  Chat = "chat",
  Decisions = "decisions",
}

/** What a model used for what it cannot do takes (#906): the model, what it is and the call. */
export interface ModelKindErrorOptions {
  /** The model's `name`. */
  readonly model: string;
  readonly kind: ModelKind;
  readonly call: "invoke" | "decide";
  readonly cause?: unknown;
}

/**
 * A model used for what it cannot do: `decide` on a chat model, `invoke` on a decision model
 * (`openai/gpt-6-luna-decisions`, `typesafe/jev-1.13`, …).
 */
export class ModelKindError extends AGBossError {
  static override readonly code = "model.wrong-kind" as const;
  declare readonly code: typeof ModelKindError.code;
  override name = "ModelKindError";

  /** The model's `name`. */
  readonly model: string;
  /** What the model is: a chat model, or a decision model. */
  readonly kind: ModelKind;
  /** The call that was made on it. */
  readonly call: "invoke" | "decide";

  constructor(options: ModelKindErrorOptions) {
    const { model, kind, call, cause } = options;
    const instead = kind === ModelKind.Chat ? "invoke(…)" : "decide(…)";
    super(`${call}(…) on ${model}: it is a ${kind} model — use ${instead}`, {
      cause,
      details: { model, kind, call },
    });
    this.model = model;
    this.kind = kind;
    this.call = call;
  }
}
