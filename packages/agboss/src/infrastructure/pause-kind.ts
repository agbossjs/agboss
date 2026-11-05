/** What a pause waits for and what a question asks (0.1.1: stored on every pause record). */

/** What a pause waits for (#659): a tool call's approval, or a question role's answer. */
export enum PauseKind {
  /** An agent's tool call through its channel: `ask` is the call, the answer a `ToolCallApprovalDecisionDto`. */
  Approval = "approval",
  /** A question role's step or tool (#659, #712): `ask` is the role's ask, the answer its `answer` DTO. */
  Question = "question",
}

declare const questionAsk: unique symbol;

/**
 * What a question role asks (#659): the role's `ask` value, `sensitive` fields masked — the
 * project's own DTO, so opaque here: a field of a `PendingPause`'s ask is read only after narrowing
 * on `kind` (an approval's ask keeps its typing), and a question's is read by assigning it to
 * `Readonly<Record<string, unknown>>` (0.1.1 API review). A plain object is not one.
 */
export type QuestionAsk = Readonly<{ [questionAsk]: true }>;

/**
 * A question's ask as the framework made it — the role's DTO, masked — or as a store of your own
 * reads it back (a question pause's `ask`, kept as written): the one place it is branded. Anything
 * but an object (`null`, an array, a text) throws `TypeError`.
 */
export function questionAskOf(ask: unknown): QuestionAsk {
  if (typeof ask !== "object" || ask === null || Array.isArray(ask))
    throw new TypeError(
      `a question's ask is an object (the role's ask DTO), not ${JSON.stringify(ask)}`,
    );
  return ask as QuestionAsk;
}
