import type { ToolCallRecord } from "../../flow/runtime/tool-calls.js";
import type { EvalCase, EvalTurn } from "../suite/cases.js";
import { CheckStatus } from "../suite/checks.js";
import type { CaseContextValues } from "./case-frame.js";
import { writeCaseHistory } from "./case-history.js";
import type { SuiteRunParts } from "./case-run.js";
import { runTurns } from "./case-turns.js";
import { METAMORPHIC_CHECK, type EvalCheckResult } from "./report.js";
import { ranToolNames, trajectoryFailures } from "./trajectory.js";

/**
 * `agboss eval run --metamorphic` (#396 PR 7, S2 Q12a): each of a case's `variants` — its last turn
 * reworded — runs on a thread of its own with the case's history and earlier turns, and must call
 * the same set of tool classes as the case's own last turn, with the case's `tools.required` (and
 * their partial arguments) met again: a reworded question that changes what the agent does is a
 * failure of the run, whatever its answer says.
 */

/** What the check says, and what its variants' runs spent. */
export interface MetamorphicOutcome {
  readonly result: EvalCheckResult;
  readonly spentUsd: number;
}

const listed = (names: readonly string[]): string =>
  names.length === 0 ? "no tool" : names.join(", ");

/** Why one variant breaks the relation; none = it holds. */
async function variantFailures(
  parts: SuiteRunParts,
  written: EvalCase,
  run: { readonly variant: EvalTurn; readonly index: number; readonly values: CaseContextValues },
  expectedTools: readonly string[],
): Promise<{ readonly failures: readonly string[]; readonly spentUsd: number }> {
  const label = `variant ${String(run.index + 1)}`;
  const threadId = parts.newThreadId();
  await writeCaseHistory(
    parts.deps,
    { tenantId: run.values.tenant.tenantId, threadId },
    written.history ?? [],
  );
  const turns = [...written.turns.slice(0, -1), run.variant];
  const outcome = await runTurns(parts, { ...written, turns }, { threadId, values: run.values });
  if (outcome.kind === "failed")
    return {
      failures: [`${label}: ${outcome.error.code}: ${outcome.error.message}`],
      spentUsd: outcome.spentUsd,
    };
  const calls = outcome.last.toolCalls;
  const tools = ranToolNames(calls);
  const sameTools =
    tools.length === expectedTools.length && tools.every((name, i) => name === expectedTools[i]);
  const missing = trajectoryFailures({ required: written.tools?.required ?? [] }, calls);
  const failures = [
    ...(sameTools ? [] : [`${label} calls ${listed(tools)}, not ${listed(expectedTools)}`]),
    ...missing.map((reason) => `${label}: ${reason}`),
  ];
  return { failures, spentUsd: outcome.spentUsd };
}

/** Every variant of the case against its own last turn's tool calls. */
export async function runMetamorphicCheck(
  parts: SuiteRunParts,
  written: EvalCase,
  values: CaseContextValues,
  original: readonly ToolCallRecord[],
): Promise<MetamorphicOutcome> {
  const expectedTools = ranToolNames(original);
  const failures: string[] = [];
  let spentUsd = 0;
  for (const [index, variant] of (written.variants ?? []).entries()) {
    const found = await variantFailures(parts, written, { variant, index, values }, expectedTools);
    failures.push(...found.failures);
    spentUsd += found.spentUsd;
  }
  const metrics = { variants: written.variants?.length ?? 0 };
  const result: EvalCheckResult =
    failures.length === 0
      ? { check: METAMORPHIC_CHECK, status: CheckStatus.Passed, metrics, spentUsd }
      : {
          check: METAMORPHIC_CHECK,
          status: CheckStatus.Failed,
          reason: failures.join("; "),
          metrics,
          spentUsd,
        };
  return { result, spentUsd };
}
