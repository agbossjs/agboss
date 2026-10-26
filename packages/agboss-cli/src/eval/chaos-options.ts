import { ChaosFailure, type EvalRunChaos } from "@agboss/core/eval";
import type { ChaosOptions } from "@agboss/core/internal";
import { textOption, type CommandContext } from "../cli/context.js";
import { usageError } from "../cli/errors.js";

/**
 * `agboss eval run --chaos <rate> --chaos-seed <n> [--chaos-failures <list>]` (#396 PR 6, S2 Q11):
 * failures injected into the run's model calls. The rate and the seed come together — a chaos run
 * is one that can be repeated — and the failures default to every `ChaosFailure`.
 */

const COMMAND = "eval run";

const KNOWN: readonly string[] = Object.values(ChaosFailure);

const isChaosFailure = (value: string): value is ChaosFailure => KNOWN.includes(value);

function rateOf(given: string): number {
  const rate = Number(given);
  if (rate > 0 && rate <= 1) return rate;
  throw usageError(
    COMMAND,
    "usage.option-value",
    `option --chaos needs a share of the model calls above 0 and at most 1 (0.2), got "${given}"`,
  );
}

function seedOf(given: string | undefined): number {
  if (given === undefined)
    throw usageError(
      COMMAND,
      "usage.missing-option",
      "--chaos needs --chaos-seed <n>: the rate and the seed come together, so the run can be repeated",
    );
  const seed = Number(given);
  if (Number.isSafeInteger(seed)) return seed;
  throw usageError(
    COMMAND,
    "usage.option-value",
    `option --chaos-seed needs a whole number, got "${given}"`,
  );
}

function failuresOf(given: string | undefined): readonly ChaosFailure[] {
  if (given === undefined) return Object.values(ChaosFailure);
  const names = given
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const unknown = names.filter((name) => !isChaosFailure(name));
  if (names.length > 0 && unknown.length === 0) return names.filter(isChaosFailure);
  throw usageError(
    COMMAND,
    "usage.option-value",
    `option --chaos-failures takes ${KNOWN.join(", ")} (comma-separated), got "${given}"`,
  );
}

/** The run's chaos; undefined without `--chaos`. */
export function chaosOf(context: CommandContext): ChaosOptions | undefined {
  const rate = textOption(context.values, "chaos");
  const seed = textOption(context.values, "chaos-seed");
  const failures = textOption(context.values, "chaos-failures");
  if (rate === undefined) {
    const alone =
      seed === undefined
        ? failures === undefined
          ? undefined
          : "--chaos-failures"
        : "--chaos-seed";
    if (alone === undefined) return undefined;
    throw usageError(COMMAND, "usage.missing-option", `${alone} needs --chaos <rate>`);
  }
  return { rate: rateOf(rate), seed: seedOf(seed), failures: failuresOf(failures) };
}

/** `chaos: rate 0.2, seed 7 — 5 of 31 model calls failed on purpose (rate-limited 2, …)`. */
export function chaosLine(chaos: EvalRunChaos): string {
  const injected = Object.values(ChaosFailure).filter((failure) =>
    chaos.failures.includes(failure),
  );
  const total = injected.reduce((sum, failure) => sum + chaos.injected[failure], 0);
  const counts = injected
    .map((failure) => `${failure} ${String(chaos.injected[failure])}`)
    .join(", ");
  return `chaos: rate ${String(chaos.rate)}, seed ${String(chaos.seed)} — ${String(total)} of ${String(chaos.calls)} model calls failed on purpose (${counts})`;
}
