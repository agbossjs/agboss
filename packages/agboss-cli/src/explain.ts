import { explanationLines, explanationsOf } from "./cli/explain-catalog.js";
import { flagOption, type CommandHandler } from "./cli/context.js";
import { didYouMean } from "./cli/did-you-mean.js";
import { usageError } from "./cli/errors.js";

/**
 * `agboss explain <code> [--json]` (#1325c): what an assembly rule, a check code or an error code
 * means and how to fix it — `agboss explain input.outdated-on-path`, `agboss explain limit.budget`.
 * `agboss explain --list` lists every code it knows. No application is loaded, no API key needed.
 */
export const handle: CommandHandler = (context) => {
  const known = explanationsOf();
  if (flagOption(context.values, "list")) {
    const codes = [...known.keys()].sort();
    if (!context.json) codes.forEach(context.say);
    return Promise.resolve({ result: { codes } });
  }
  const [given, ...extra] = context.positionals;
  if (given === undefined || extra.length > 0)
    throw usageError("explain", "usage.missing-argument", "expected agboss explain <code>");
  // `[input.outdated-on-path]` as the check prints it, or the bare code
  const code = given.replace(/^\[(.*)\]$/u, "$1");
  const found = known.get(code);
  if (found === undefined)
    throw usageError(
      "explain",
      "usage.unknown-code",
      `no explanation for "${code}".${didYouMean(code, [...known.keys()])} agboss explain --list lists the codes`,
    );
  explanationLines(found).forEach(context.say);
  return Promise.resolve({ result: found });
};
