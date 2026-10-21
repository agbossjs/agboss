import type { UsageRecord } from "../finops/usage.js";
import { PiiActionKind, type MaskingPiiAction } from "./actions.js";
import { PiiRefusedError } from "./errors.js";
import { maskedText, withoutOverlaps, type MaskedText, type PiiFinding } from "./masking.js";
import { DetectionMode, type RuntimePiiPolicy } from "./runtime-policy.js";
import type { PiiTokenMap } from "./tokens.js";

/**
 * The policies in effect at one place (an agent's or a router's model, the observability layer),
 * applied together: every policy's findings, overlaps resolved (the longest wins), then the actions.
 * Known sensitive values (the identity fields of the execution's contexts, #120 AC13) are found
 * wherever they appear.
 */

/** A value marked `sensitive` that is found by itself, wherever it appears. */
export interface SensitiveValue {
  readonly value: string;
  /** The field's name in kebab case: `<user-id:…>`. */
  readonly label: string;
  readonly action: MaskingPiiAction;
}

/** A masked text and what its model searches cost. */
export interface MaskedSearch {
  readonly masked: MaskedText;
  readonly usage: readonly UsageRecord[];
}

function valueFindings(text: string, values: readonly SensitiveValue[], key: string): PiiFinding[] {
  return values.flatMap((sensitive) => {
    const found: PiiFinding[] = [];
    if (sensitive.value.length < 2) return found;
    for (
      let at = text.indexOf(sensitive.value);
      at >= 0;
      at = text.indexOf(sensitive.value, at + 1)
    ) {
      const { label, action } = sensitive;
      found.push({
        start: at,
        end: at + sensitive.value.length,
        label,
        action,
        key,
        policy: label,
        rank: -2,
      });
    }
    return found;
  });
}

export class PiiPolicySet {
  constructor(
    readonly policies: readonly RuntimePiiPolicy[],
    /** The HMAC key of tokens no policy key covers: sensitive fields and values. */
    readonly fieldKey: string,
    private readonly values: readonly SensitiveValue[] = [],
  ) {}

  /** Whether nothing is masked here. */
  get isEmpty(): boolean {
    return this.policies.length === 0 && this.values.length === 0;
  }

  /** The same policies with the sensitive values of one execution. */
  withValues(values: readonly SensitiveValue[]): PiiPolicySet {
    return values.length === 0
      ? this
      : new PiiPolicySet(this.policies, this.fieldKey, [...this.values, ...values]);
  }

  /**
   * The same policies making their field tokens with an execution's own key (#334): the key of a
   * root execution when the application sets none; none (an old checkpoint) keeps this set's.
   */
  withFieldKey(key: string | null | undefined): PiiPolicySet {
    return key === null || key === undefined || key === this.fieldKey
      ? this
      : new PiiPolicySet(this.policies, key, this.values);
  }

  /** Every policy's findings in `text`, applied; new tokens made against `known`. */
  async mask(text: string, known: PiiTokenMap, mode: DetectionMode): Promise<MaskedSearch> {
    if (this.isEmpty || text === "")
      return { masked: { text, tokens: {}, blocked: [] }, usage: [] };
    const searches = await Promise.all(this.policies.map((policy) => policy.find(text, mode)));
    const findings = [
      ...searches.flatMap((search) => search.findings),
      ...valueFindings(text, this.values, this.fieldKey),
    ];
    return {
      masked: maskedText(text, withoutOverlaps(findings), known),
      usage: searches.flatMap((search) => search.usage),
    };
  }

  /** What the formats find, applied at once (the log); a block rule shows as `<kind>`. */
  maskNow(text: string): string {
    if (this.isEmpty || text === "") return text;
    const findings = [
      ...this.policies.flatMap((policy) => policy.findNow(text)),
      ...valueFindings(text, this.values, this.fieldKey),
    ];
    return findings.length === 0 ? text : maskedText(text, withoutOverlaps(findings), {}).text;
  }

  /** The refusal of the first blocked finding, as the error the boundary throws. */
  async refusalError(
    blocked: readonly PiiFinding[],
    usage: readonly UsageRecord[],
  ): Promise<PiiRefusedError | undefined> {
    const [finding] = blocked;
    if (finding?.action.kind !== PiiActionKind.BlockWithRefusal) return undefined;
    const policy = this.policies.find((candidate) => candidate.name === finding.policy);
    const refusal = (await policy?.refusalOf(finding.kind, finding.action)) ?? "";
    return new PiiRefusedError(finding.label, refusal, usage);
  }
}
