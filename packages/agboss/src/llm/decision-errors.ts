import { AGBossError, type MessageErrorOptions } from "../core/errors.js";

/** A decision call failed on the framework's side of the Decisions API. */
export class DecisionError extends AGBossError {
  static override readonly code: string = "model.decision";
  declare readonly code:
    "model.decision" | "model.decision.invalid-request" | "model.decision.invalid-response";
  override name = "DecisionError";

  constructor(options: MessageErrorOptions) {
    super(options.message, options);
  }
}

/** A decision request the Decisions API would refuse: too many questions, a bad image, no options. */
export class DecisionRequestError extends DecisionError {
  static override readonly code = "model.decision.invalid-request" as const;
  declare readonly code: typeof DecisionRequestError.code;
  override name = "DecisionRequestError";
}

/** A Decisions API answer that is unknown or malformed (a missing answer, an option never asked). */
export class DecisionResponseError extends DecisionError {
  static override readonly code = "model.decision.invalid-response" as const;
  declare readonly code: typeof DecisionResponseError.code;
  override name = "DecisionResponseError";
}

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
