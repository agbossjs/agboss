import { PiiActionKind, type AnyPiiAction } from "./actions.js";
import type { PiiKind } from "./kinds.js";
import type { PiiMatch } from "./pii-policy.decorator.js";
import { kindPlaceholder, partReplaced } from "./replacement.js";
import { tokenOf, type PiiTokenMap } from "./tokens.js";

/**
 * One value found in a text and what to do with it: its range, its label (`email`, or a project
 * detector's name without `-pii-policy`), the kind when a rule named one, the action, and the
 * policy (with its HMAC key) that found it.
 */
export interface PiiFinding extends PiiMatch {
  readonly label: string;
  readonly kind?: PiiKind;
  readonly action: AnyPiiAction;
  readonly policy: string;
  readonly key: string;
  /** The more specific detector wins a tie (lower first). */
  readonly rank: number;
}

const lengthOf = (finding: PiiMatch): number => finding.end - finding.start;

const isBefore = (first: PiiFinding, second: PiiFinding): boolean =>
  lengthOf(first) !== lengthOf(second)
    ? lengthOf(first) > lengthOf(second)
    : first.rank !== second.rank
      ? first.rank < second.rank
      : first.start < second.start;

/** Overlapping ranges: the longest wins (#120 AC3), a tie by rank; the rest in text order. */
export function withoutOverlaps(findings: readonly PiiFinding[]): PiiFinding[] {
  const kept: PiiFinding[] = [];
  const ordered = [...findings]
    .filter((finding) => finding.end > finding.start)
    .sort((first, second) => (isBefore(first, second) ? -1 : 1));
  for (const finding of ordered) {
    const overlaps = kept.some((other) => finding.start < other.end && other.start < finding.end);
    if (!overlaps) kept.push(finding);
  }
  return kept.sort((first, second) => first.start - second.start);
}

/** A text with its findings applied: the new tokens it made and what a block rule matched. */
export interface MaskedText {
  readonly text: string;
  /** Tokens this text introduced (token → value): the `piiTokens` the boundary writes. */
  readonly tokens: Record<string, string>;
  /** Findings of `blockWithRefusal` rules: shown as `<kind>`; the boundary refuses on them. */
  readonly blocked: readonly PiiFinding[];
}

function replacementOf(
  finding: PiiFinding,
  value: string,
  known: Record<string, string>,
): { readonly text: string; readonly token?: string } {
  switch (finding.action.kind) {
    case PiiActionKind.ReplaceWithToken: {
      const token = tokenOf(finding.label, value, finding.key, known);
      return { text: token, token };
    }
    case PiiActionKind.ReplacePart:
      return { text: partReplaced(value, finding.action.part) };
    case PiiActionKind.ReplaceWithKind:
    case PiiActionKind.BlockWithRefusal:
      return { text: kindPlaceholder(finding.label) };
  }
}

/** Applies the findings (already without overlaps) to the text, right to left. */
export function maskedText(
  text: string,
  findings: readonly PiiFinding[],
  known: PiiTokenMap,
): MaskedText {
  const tokens: Record<string, string> = {};
  const all: Record<string, string> = { ...known };
  const blocked = findings.filter((item) => item.action.kind === PiiActionKind.BlockWithRefusal);
  let masked = text;
  for (const finding of [...findings].sort((first, second) => second.start - first.start)) {
    const value = text.slice(finding.start, finding.end);
    const replacement = replacementOf(finding, value, all);
    if (replacement.token !== undefined) {
      tokens[replacement.token] = value;
      all[replacement.token] = value;
    }
    masked = `${masked.slice(0, finding.start)}${replacement.text}${masked.slice(finding.end)}`;
  }
  return { text: masked, tokens, blocked };
}
