/**
 * A separate process for the kill-and-resume tests:
 * `node --import tsx loop-process.ts <dir> <start|resume|recover> <approval|parallel>`.
 * Effects and model calls are appended to files in <dir>, so they add up across processes; the
 * checkpoints live in <dir>/checkpoints.json.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runInFrame } from "../../../src/flow/context/frame.js";
import { liveExecutionContextOf } from "../../../src/flow/context/live-context.js";
import { testExecutionContext } from "../../../src/testing/execution-context.js";
import { defineTool } from "../../../src/tools/index.js";
import { FileCheckpointSaver } from "./file-checkpointer.js";
import {
  replyWith,
  callTools,
  decision,
  harness,
  read,
  repoTools,
  runLoop,
  startInput,
  write,
  type ScriptedMove,
} from "./fixtures.js";

const Args = z.tuple([
  z.string(),
  z.enum(["start", "resume", "recover"]),
  z.enum(["approval", "parallel"]),
]);
const [dir, mode, scenario] = Args.parse(process.argv.slice(2));
const THREAD = "run-1";

const executionContext = liveExecutionContextOf(undefined, "slow_step");

const log = (effect: string): void => {
  appendFileSync(join(dir, "effects.log"), `${effect}\n`);
};

/** Hangs as long as SLOW_MS says: long in the process that gets killed, short after. */
const slowStep = defineTool({
  name: "slow_step",
  description: "A slow step",
  input: z.object({}),
  output: z.string(),
  timeoutMs: 120_000,
  run: async () => {
    const { callId } = executionContext.step; // the tool call's frame: the same id after a crash
    log(`slow started ${String(callId)}`);
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.SLOW_MS ?? "1")));
    log(`slow finished ${String(callId)}`);
    return "slow done";
  },
});

const scripts: Record<typeof scenario, readonly ScriptedMove[]> = {
  approval: [
    callTools(read("r1", "a.ts")),
    callTools(write("w1", "a.ts", "new")),
    replyWith("written"),
  ],
  parallel: [
    callTools(read("fast", "fast.ts"), { id: "slow", name: "slow_step", args: {} }),
    replyWith("both done"),
  ],
};

const { graph } = harness(
  {
    moves: scripts[scenario],
    log,
    tools: (effect) => [...repoTools(effect), slowStep],
    onModelCall: (move) => {
      appendFileSync(join(dir, "model-calls.log"), `${String(move)}\n`);
    },
  },
  new FileCheckpointSaver(join(dir, "checkpoints.json")),
);

const input =
  mode === "start"
    ? startInput()
    : mode === "resume"
      ? decision({ approved: true, by: "lead" })
      : null;

/** The agent's step around the loop (what the node runner opens in a workflow, #280). */
const agent = testExecutionContext({ executionId: THREAD });
const { executionId, threadId, ownerId, signal, workflow, tenant } = agent;
const frame = {
  execution: { executionId, threadId, ownerId, signal, workflow, tenant, values: {} },
  step: agent.step,
};
const result = await runInFrame(frame, () => runLoop(graph, input, THREAD));
process.stdout.write(`${JSON.stringify(result)}\n`);
// a paused run waits for its decision: the process stays up until it is killed
if (mode === "start") setInterval(() => undefined, 60_000);
