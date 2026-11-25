import { StepError } from "../core/error-families/step-errors.js";
import { recordUsage, type UsageRecord } from "../finops/usage.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { ModelBinding } from "../llm/registry.js";
import { regionsOf, RegionsAnswerError, type Region } from "./redaction-regions.js";

/** The log code of a region the model named with a target it was not asked for (#1301). */
export const UNKNOWN_TARGET_CODE = "files.redactor-unknown-target";

/** The regions of the model's answer, strictly checked; its spend with them. */
export function answeredRegions(
  response: Awaited<ReturnType<ModelBinding["model"]["invoke"]>>,
  of: {
    readonly agent: string;
    readonly known: ReadonlySet<string>;
    readonly maxRegions: number;
    readonly log: FrameworkLog;
  },
  binding: ModelBinding,
): { readonly regions: readonly Region[]; readonly usage: UsageRecord } {
  const { agent, known, maxRegions, log } = of;
  try {
    return {
      regions: regionsOf(response.text, known, maxRegions, (count) => {
        // painted all the same; the model's own words are never in the line
        log.warn(
          UNKNOWN_TARGET_CODE,
          `${agent}: the redaction model named ${String(count)} region(s) with a target it was not asked for — painted all the same`,
        );
      }),
      usage: recordUsage("files:redactor", binding.settings, response),
    };
  } catch (error) {
    // the reason is structural; the answer itself is neither in the message nor in the cause
    const said = error instanceof RegionsAnswerError ? error.message : "unreadable";
    throw new StepError.FileMaskingFailed({
      agent,
      reason: `the redaction model's answer is not usable: ${said}`,
    });
  }
}
