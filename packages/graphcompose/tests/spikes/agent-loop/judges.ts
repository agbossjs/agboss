import type {
  CallVerdict,
  Judge,
  JudgePoint,
  JudgeRecord,
  LoopAgent,
  LoopTool,
  CallJudge,
  ResultJudge,
} from "./types.js";

/** Revisions used so far in the step, and the step's overall limit. */
export interface RevisionLedger {
  readonly used: Readonly<Record<string, number>>;
  readonly maxPerStep: number;
}

/** What a chain of judges decided about one move, plus what to record. */
export interface JudgeOutcome<TVerdict extends CallVerdict> {
  readonly verdict: TVerdict | { readonly kind: "accept" };
  readonly records: readonly JudgeRecord[];
  /** Updated counters (only keys that changed). */
  readonly revisions: Readonly<Record<string, number>>;
}

const keyOf = (judge: { readonly name: string }, point: JudgePoint): string =>
  `${judge.name}@${point}`;

const totalUsed = (used: Readonly<Record<string, number>>): number =>
  Object.values(used).reduce((sum, count) => sum + count, 0);

const record = (
  judge: string,
  point: JudgePoint,
  verdict: CallVerdict,
  exhausted: boolean,
): JudgeRecord => ({
  judge,
  point,
  verdict: verdict.kind,
  note:
    verdict.kind === "revise" ? verdict.remark : verdict.kind === "reject" ? verdict.reason : "",
  exhausted,
});

/**
 * Runs judges in order (tool judges first, then agent judges). The first effective non-accept
 * verdict wins. A revise past `maxRevisions` (per judge and point) or the step's limit is recorded
 * as exhausted and the move goes through — never a silent loop.
 */
export async function runJudges<TMove, TVerdict extends CallVerdict>(
  judges: readonly Judge<TMove, TVerdict>[],
  move: TMove,
  point: JudgePoint,
  ledger: RevisionLedger,
): Promise<JudgeOutcome<TVerdict>> {
  const used: Record<string, number> = { ...ledger.used };
  const changed: Record<string, number> = {};
  const records: JudgeRecord[] = [];
  for (const judge of judges) {
    const verdict = await judge.judge(move);
    if (verdict.kind === "accept") {
      records.push(record(judge.name, point, verdict, false));
      continue;
    }
    if (verdict.kind === "reject") {
      records.push(record(judge.name, point, verdict, false));
      return { verdict, records, revisions: changed };
    }
    const key = keyOf(judge, point);
    const count = used[key] ?? 0;
    const exhausted = count >= judge.maxRevisions || totalUsed(used) >= ledger.maxPerStep;
    records.push(record(judge.name, point, verdict, exhausted));
    if (exhausted) continue;
    used[key] = count + 1;
    changed[key] = count + 1;
    return { verdict, records, revisions: changed };
  }
  return { verdict: { kind: "accept" }, records, revisions: changed };
}

/** Before a call: the tool's own judges, then the agent's judges scoped to that tool. */
export const callJudgesFor = (agent: LoopAgent, tool: LoopTool): readonly CallJudge[] => [
  ...tool.beforeCall,
  ...agent.judges.beforeCall.filter((scoped) => scoped.tool === tool.name).map((s) => s.judge),
];

/** After a call: the same order. */
export const resultJudgesFor = (agent: LoopAgent, tool: LoopTool): readonly ResultJudge[] => [
  ...tool.afterCall,
  ...agent.judges.afterCall.filter((scoped) => scoped.tool === tool.name).map((s) => s.judge),
];

export class UnknownToolError extends Error {
  override name = "UnknownToolError";
}

export function toolOf(agent: LoopAgent, name: string): LoopTool {
  const tool = agent.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new UnknownToolError(`Agent ${agent.name} has no tool ${name}`);
  return tool;
}
