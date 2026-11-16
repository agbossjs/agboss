import { createHash, createHmac } from "node:crypto";
import type { UsageRecord } from "../finops/usage.js";
import { PiiActionKind, type MaskingPiiAction } from "./actions.js";
import type { PiiKind } from "./kinds.js";
import { isCustomPolicy, PiiFileAction } from "./pii-policy.decorator.js";
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

  /**
   * Whether a policy has a block rule (`blockWithRefusal`): an answer that holds such a value is
   * refused, so what streams of it waits for that check (#1006).
   */
  get blocks(): boolean {
    return this.policies.some((policy) =>
      [...policy.actions.values()].some((action) => action.kind === PiiActionKind.BlockWithRefusal),
    );
  }

  /**
   * What this set masks with, as a short hash: its policies (their rules or action, model detection and
   * file action), the execution's key and its sensitive values. A masked text kept for reuse (a file's
   * transcription, #899 §7) is keyed by it, so it is never handed to a place that masks differently.
   */
  get fingerprint(): string {
    const policies = this.policies.map(({ meta }) => ({
      name: meta.name,
      masks: isCustomPolicy(meta) ? meta.action : meta.rules,
      model: isCustomPolicy(meta) ? null : (meta.detectWithModel ?? null),
      files: meta.files ?? null,
    }));
    const values = this.values.map(({ value, label, action }) => [label, value, action]);
    const text = JSON.stringify([policies, this.fieldKey, values]);
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
  }

  /**
   * A keyed digest (HMAC-SHA-256 with this set's key, never a plain hash: a key that names a value set must
   * not be an oracle for the values) of a list of texts, sorted and joined: what a cache key says of them.
   */
  keyedDigestOf(texts: readonly string[]): string {
    const sorted = JSON.stringify([...texts].sort());
    return createHmac("sha256", this.fieldKey).update(sorted).digest("hex").slice(0, 32);
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

  /**
   * What a redactor is asked to black out in a file (#899 §5): every kind the declarative policies' rules
   * name (groups expanded), whatever their action, and the execution's sensitive values. A project's own
   * detector reads text only, so it names no kind: `[pii.redacted-needs-kinds]` refuses it at start.
   */
  get redaction(): {
    readonly kinds: readonly PiiKind[];
    readonly values: readonly string[];
    /** The kinds a block rule names: a file that holds one is refused. */
    readonly blocked: readonly PiiKind[];
    /** Whether every policy with a block rule lets a model decide what an image holds (`RedactWithModel`). */
    readonly isModelChecked: boolean;
  } {
    const kinds = new Set<PiiKind>(this.policies.flatMap((policy) => [...policy.actions.keys()]));
    const blocking = this.policies.filter((policy) =>
      [...policy.actions.values()].some((action) => action.kind === PiiActionKind.BlockWithRefusal),
    );
    return {
      kinds: [...kinds],
      values: this.values.map(({ value }) => value),
      blocked: [
        ...new Set(
          blocking.flatMap((policy) =>
            [...policy.actions].flatMap(([kind, action]) =>
              action.kind === PiiActionKind.BlockWithRefusal ? [kind] : [],
            ),
          ),
        ),
      ],
      isModelChecked: blocking.every(
        (policy) => policy.meta.files === PiiFileAction.RedactWithModel,
      ),
    };
  }

  /**
   * The refusal for a kind a redactor found in a file, when a block rule names it: the error the boundary
   * throws (the file never goes to the model). Other kinds are blacked out, not refused.
   */
  async refusalForKind(kind: PiiKind): Promise<PiiRefusedError | undefined> {
    for (const policy of this.policies) {
      const action = policy.actions.get(kind);
      if (action?.kind === PiiActionKind.BlockWithRefusal)
        return new PiiRefusedError({ kind, refusal: await policy.refusalOf(kind, action) });
    }
    return undefined;
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
    return new PiiRefusedError({ kind: finding.label, refusal, usage });
  }
}
