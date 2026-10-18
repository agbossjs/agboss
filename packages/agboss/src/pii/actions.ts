/**
 * What happens to a value a PII rule found (#120) — the action names say it: `replaceWithKind()`
 * → `<israeli-id>`, `replacePart(…)` → `•••• 4242` / `d•••@acme.com`, `replaceWithToken()` →
 * `<email:7f3a91>` (the only reversible one: a tool inside the execution gets the real value),
 * `blockWithRefusal(…)` — the message or the tool call is not processed at all.
 */

/** The four actions, by what they do. */
export enum PiiActionKind {
  ReplaceWithKind = "replace-with-kind",
  ReplacePart = "replace-part",
  ReplaceWithToken = "replace-with-token",
  BlockWithRefusal = "block-with-refusal",
}

/** `replacePart({ keepFirst, keepLast, keepDomain })`: what of the value stays visible. */
export interface PiiKeptPart {
  readonly keepFirst?: number;
  readonly keepLast?: number;
  /** An email keeps its domain (and the local part's first character). */
  readonly keepDomain?: boolean;
  readonly pattern?: never;
}

/** `replacePart({ pattern })`: what of the value is replaced — every match. */
export interface PiiReplacedPart {
  readonly pattern: RegExp;
  readonly keepFirst?: never;
  readonly keepLast?: never;
  readonly keepDomain?: never;
}

/** Either what to keep or what to replace — both at once does not compile. */
export type PiiPartOptions = PiiKeptPart | PiiReplacedPart;

/** `<israeli-id>`: the value replaced by its kind, one-way. */
export interface ReplaceWithKindAction {
  readonly kind: PiiActionKind.ReplaceWithKind;
}

/** `•••• 4242`: part of the value replaced, one-way. */
export interface ReplacePartAction {
  readonly kind: PiiActionKind.ReplacePart;
  readonly part: PiiPartOptions;
}

/** `<email:7f3a91>`: one HMAC token per value, revealed again when it comes back from the model. */
export interface ReplaceWithTokenAction {
  readonly kind: PiiActionKind.ReplaceWithToken;
}

/** The message or the call is refused: with this text, or the policy's `refusal(kind)`. */
export interface BlockWithRefusalAction {
  readonly kind: PiiActionKind.BlockWithRefusal;
  readonly refusal?: string;
}

/** An action that masks the value (the only ones a field's `sensitive` or a custom policy takes). */
export type MaskingPiiAction = ReplaceWithKindAction | ReplacePartAction | ReplaceWithTokenAction;

/** Any action of a rule. */
export type AnyPiiAction = MaskingPiiAction | BlockWithRefusalAction;

/** `blockWithRefusal({ refusal })`: the text sent instead. */
export interface PiiRefusalOptions {
  readonly refusal: string;
}

/** The actions: `PiiAction.replaceWithToken()`, `PiiAction.replacePart({ keepLast: 4 })`, … */
export const PiiAction = {
  replaceWithKind: (): ReplaceWithKindAction => ({ kind: PiiActionKind.ReplaceWithKind }),
  replacePart: (part: PiiPartOptions): ReplacePartAction => ({
    kind: PiiActionKind.ReplacePart,
    part,
  }),
  replaceWithToken: (): ReplaceWithTokenAction => ({ kind: PiiActionKind.ReplaceWithToken }),
  blockWithRefusal: (options?: PiiRefusalOptions): BlockWithRefusalAction =>
    options === undefined
      ? { kind: PiiActionKind.BlockWithRefusal }
      : { kind: PiiActionKind.BlockWithRefusal, refusal: options.refusal },
} as const;

/** Whether an action masks (else it blocks). */
export const isMaskingAction = (action: AnyPiiAction): action is MaskingPiiAction =>
  action.kind !== PiiActionKind.BlockWithRefusal;

const partText = (part: PiiPartOptions): string =>
  part.pattern === undefined
    ? JSON.stringify({
        keepFirst: part.keepFirst,
        keepLast: part.keepLast,
        keepDomain: part.keepDomain,
      })
    : `{"pattern":${JSON.stringify(String(part.pattern))}}`;

/** An action as written: `replacePart({"keepLast":4})`, `blockWithRefusal("…")` (messages, conflicts). */
export function actionText(action: AnyPiiAction): string {
  switch (action.kind) {
    case PiiActionKind.ReplaceWithKind:
      return "replaceWithKind()";
    case PiiActionKind.ReplaceWithToken:
      return "replaceWithToken()";
    case PiiActionKind.ReplacePart:
      return `replacePart(${partText(action.part)})`;
    case PiiActionKind.BlockWithRefusal:
      return action.refusal === undefined
        ? "blockWithRefusal()"
        : `blockWithRefusal(${JSON.stringify(action.refusal)})`;
  }
}

/** Two actions do the same (the same kind and options). */
export const isSameAction = (first: AnyPiiAction, second: AnyPiiAction): boolean =>
  actionText(first) === actionText(second);
