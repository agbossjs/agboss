import { defineFamily, type ErrorVariant, type FamilyConstructor } from "./family.js";

/** The kinds of `DecisionError`: `switch (error.kind)` is exhaustive. */
export enum DecisionErrorKind {
  InvalidRequest = "invalid-request",
  InvalidResponse = "invalid-response",
}

/** A decision call failed on the framework's side of the Decisions API: a request it would refuse, or an answer that is unknown or malformed. */
export type DecisionError = DecisionError.InvalidRequest | DecisionError.InvalidResponse;

/** The variants of `DecisionError`, each with the facts it carries. */
export declare namespace DecisionError {
  /** A decision request the Decisions API would refuse: too many questions, a bad image, no options. */
  export type InvalidRequest = ErrorVariant<
    DecisionErrorKind.InvalidRequest,
    "model.decision.invalid-request"
  >;
  /** A Decisions API answer that is unknown or malformed. */
  export type InvalidResponse = ErrorVariant<
    DecisionErrorKind.InvalidResponse,
    "model.decision.invalid-response"
  >;
}

/** `DecisionError`: the family's constructor and its variants'. */
export const DecisionError: FamilyConstructor<
  DecisionError,
  { InvalidRequest: DecisionError.InvalidRequest; InvalidResponse: DecisionError.InvalidResponse }
> = defineFamily({
  name: "DecisionError",
  code: "model.decision",
  kinds: DecisionErrorKind,
  variants: {
    InvalidRequest: [
      "a decision request the Decisions API would refuse: too many questions, a bad image, no options",
    ],
    InvalidResponse: ["a Decisions API answer that is unknown or malformed"],
  },
});
