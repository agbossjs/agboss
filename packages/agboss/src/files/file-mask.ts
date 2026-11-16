import type { UsageRecord } from "../finops/usage.js";
import type { PiiPolicySet } from "../pii/policy-set.js";
import { DetectionMode } from "../pii/runtime-policy.js";
import type { PiiTokenMap } from "../pii/tokens.js";

/**
 * How a file's text is masked where it is made (#899 §5, §7): the transcription of a file — or a text
 * format's own text — goes through the agent's PII policies once, here, and only the masked text is
 * kept (the execution's cache, its checkpoint). A block rule in it refuses (`PiiRefusedError`) before
 * anything is kept or sent. Bytes are never masked: PII reads text only.
 */

/** A masked text, the tokens it introduced and what masking it cost. */
export interface MaskedFileText {
  readonly text: string;
  readonly tokens: PiiTokenMap;
  readonly usage: readonly UsageRecord[];
}

/** The masking in effect at one place: the policies' fingerprint keys what it keeps. */
export interface FileMask {
  /** `PiiPolicySet.fingerprint`: part of a masked transcription's cache key. */
  readonly policyHash: string;
  /** The tokens the execution has so far. */
  readonly known: PiiTokenMap;
  /** The text masked against `known`; a block rule in it throws the refusal. */
  readonly mask: (text: string, known: PiiTokenMap) => Promise<MaskedFileText>;
}

/** The mask of a policy set; none when nothing is masked there. */
export function fileMaskOf(
  set: PiiPolicySet | undefined,
  known: PiiTokenMap,
): FileMask | undefined {
  if (set === undefined || set.isEmpty) return undefined;
  return {
    policyHash: set.fingerprint,
    known,
    mask: async (text, tokens) => {
      const { masked, usage } = await set.mask(text, tokens, DetectionMode.WithModel);
      const refused = await set.refusalError(masked.blocked, usage);
      if (refused !== undefined) throw refused;
      return { text: masked.text, tokens: masked.tokens, usage };
    },
  };
}
