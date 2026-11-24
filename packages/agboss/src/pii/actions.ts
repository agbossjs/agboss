/**
 * What happens to a value a PII rule found (#120, #1301) — three verbs: `mask()` → `<israeli-id>`,
 * `mask(part)` → `•••• 4242` / `d•••@acme.com` (both one-way), `tokenize()` → `<email:7f3a91>` (the
 * only reversible one: a tool inside the execution gets the real value), `block(refusal?)` — the
 * message or the tool call is not processed at all.
 */

/** The actions, by what they do. */
export enum PiiActionKind {
  /** `mask()`: the value replaced by its label. */
  Mask = "mask",
  /** `mask(part)`: part of the value replaced. */
  MaskPart = "mask-part",
  /** `tokenize()`: one HMAC token per value. */
  Tokenize = "tokenize",
  /** `block(refusal?)`: the message or the call refused. */
  Block = "block",
}

/** `mask({ keepFirst, keepLast, keepDomain })`: what of the value stays visible. */
export interface PiiKeptPart {
  readonly keepFirst?: number;
  readonly keepLast?: number;
  /** An email keeps its domain (and the local part's first character). */
  readonly keepDomain?: boolean;
  readonly pattern?: never;
}

/** `mask({ pattern })`: what of the value is replaced — every match. */
export interface PiiReplacedPart {
  readonly pattern: RegExp;
  readonly keepFirst?: never;
  readonly keepLast?: never;
  readonly keepDomain?: never;
}

/** Either what to keep or what to replace — both at once does not compile. */
export type PiiPartOptions = PiiKeptPart | PiiReplacedPart;

/** `<israeli-id>`: the value replaced by its label, one-way. */
export interface MaskAction {
  readonly kind: PiiActionKind.Mask;
}

/** `•••• 4242`: part of the value replaced, one-way. */
export interface MaskPartAction {
  readonly kind: PiiActionKind.MaskPart;
  readonly part: PiiPartOptions;
}

/** `<email:7f3a91>`: one HMAC token per value, revealed again when it comes back from the model. */
export interface TokenizeAction {
  readonly kind: PiiActionKind.Tokenize;
}

/** The message or the call is refused: with this text, or the policy's `refusal(kind)`. */
export interface BlockAction {
  readonly kind: PiiActionKind.Block;
  readonly refusal?: string;
}

/** An action that masks the value (the only ones a field's `sensitive` or a custom policy takes). */
export type MaskingPiiAction = MaskAction | MaskPartAction | TokenizeAction;

/** Any action of a rule. */
export type AnyPiiAction = MaskingPiiAction | BlockAction;

const MASK: MaskAction = Object.freeze({ kind: PiiActionKind.Mask });
const TOKENIZE: TokenizeAction = Object.freeze({ kind: PiiActionKind.Tokenize });

function maskAction(): MaskAction;
function maskAction(part: PiiPartOptions): MaskPartAction;
function maskAction(part?: PiiPartOptions): MaskAction | MaskPartAction {
  return part === undefined ? MASK : { kind: PiiActionKind.MaskPart, part };
}

/** The actions: `PiiAction.tokenize()`, `PiiAction.mask({ keepLast: 4 })`, `PiiAction.block()`. */
export const PiiAction: {
  /** `<israeli-id>` (no part), or `•••• 4242` (`{ keepLast: 4 }`): one-way. */
  readonly mask: {
    (): MaskAction;
    (part: PiiPartOptions): MaskPartAction;
  };
  /** `<email:7f3a91>`: revealed again when the model gives it back. */
  readonly tokenize: () => TokenizeAction;
  /** Refuses the message or the call: with `refusal`, or the policy's `refusal(kind)`. */
  readonly block: (refusal?: string) => BlockAction;
} = Object.freeze({
  mask: maskAction,
  tokenize: (): TokenizeAction => TOKENIZE,
  block: (refusal?: string): BlockAction =>
    refusal === undefined ? { kind: PiiActionKind.Block } : { kind: PiiActionKind.Block, refusal },
});

/** Whether an action masks (else it blocks). */
export const isMaskingAction = (action: AnyPiiAction): action is MaskingPiiAction =>
  action.kind !== PiiActionKind.Block;

const partText = (part: PiiPartOptions): string =>
  part.pattern === undefined
    ? JSON.stringify({
        keepFirst: part.keepFirst,
        keepLast: part.keepLast,
        keepDomain: part.keepDomain,
      })
    : `{"pattern":${JSON.stringify(String(part.pattern))}}`;

/** An action as written: `mask({"keepLast":4})`, `block("…")` (messages, conflicts). */
export function actionText(action: AnyPiiAction): string {
  switch (action.kind) {
    case PiiActionKind.Mask:
      return "mask()";
    case PiiActionKind.Tokenize:
      return "tokenize()";
    case PiiActionKind.MaskPart:
      return `mask(${partText(action.part)})`;
    case PiiActionKind.Block:
      return action.refusal === undefined ? "block()" : `block(${JSON.stringify(action.refusal)})`;
  }
}

/** Two actions do the same (the same kind and options). */
export const isSameAction = (first: AnyPiiAction, second: AnyPiiAction): boolean =>
  actionText(first) === actionText(second);
