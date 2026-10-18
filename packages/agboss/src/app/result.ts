import type { ExecutionRecord } from "../flow/runtime/execution-record.js";
import type { AgentExecutionOutput } from "../run/types.js";
import type { ExecutionOutput } from "./types.js";

/** The full record of an execution (`{ record: true }`, #270 AC16). */
const recordOf = (run: AgentExecutionOutput): ExecutionRecord => ({
  path: run.path,
  scope: Object.values(run.data.scope),
  outdatedValues: run.data.outdatedValues,
  ...(run.data.lastError === null ? {} : { lastError: run.data.lastError }),
  spend: run.cost,
});

/** An execution of the core, as the app reports it. */
export function runResultOf(run: AgentExecutionOutput, withRecord: boolean): ExecutionOutput {
  return {
    status: run.status,
    thread: run.threadId,
    runId: run.runId,
    path: run.path,
    spend: run.cost,
    launches: run.data.launches ?? [],
    ...(run.finish === undefined ? {} : { finish: { name: run.finish }, output: run.output }),
    ...(run.pending === undefined ? {} : { pause: run.pending }),
    ...(run.compacted === undefined ? {} : { compacted: run.compacted }),
    ...(run.traceUrl === undefined ? {} : { traceUrl: run.traceUrl }),
    ...(withRecord ? { record: recordOf(run) } : {}),
  };
}
