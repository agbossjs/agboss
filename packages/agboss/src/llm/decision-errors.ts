import { AGBossError } from "../core/errors.js";

/** A decision call failed on the framework's side of the Decisions API. */
export class DecisionError extends AGBossError {
  static override readonly code: string = "model.decision";
  override name = "DecisionError";
}

/** A decision request the Decisions API would refuse: too many questions, a bad image, no options. */
export class DecisionRequestError extends DecisionError {
  static override readonly code = "model.decision.invalid-request" as const;
  override name = "DecisionRequestError";
}

/** A Decisions API answer that is unknown or malformed (a missing answer, an option never asked). */
export class DecisionResponseError extends DecisionError {
  static override readonly code = "model.decision.invalid-response" as const;
  override name = "DecisionResponseError";
}

/** What a model can do (#269): chat (`invoke`) or decide (`decide`). */
export enum ModelKind {
  Chat = "chat",
  Decisions = "decisions",
}

/**
 * A model used for what it cannot do: `decide` on a chat model, `invoke` on a decision model
 * (`openai/gpt-6-luna-decisions`, `typesafe/jev-1.13`, …).
 */
export class ModelKindError extends AGBossError {
  static override readonly code = "model.wrong-kind" as const;
  override name = "ModelKindError";

  constructor(model: string, kind: ModelKind, call: "invoke" | "decide") {
    const instead = kind === ModelKind.Chat ? "invoke(…)" : "decide(…)";
    super(`${call}(…) on ${model}: it is a ${kind} model — use ${instead}`, {
      details: { model, kind, call },
    });
  }
}
