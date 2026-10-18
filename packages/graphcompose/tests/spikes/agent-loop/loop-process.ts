/**
 * A separate process for the kill-and-resume test: `node --import tsx loop-process.ts <dir> <mode>
 * <scenario>`. Effects and model calls are appended to files in <dir> so they add up across
 * processes; the checkpoint lives in <dir>/checkpoints.json.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FileCheckpointSaver } from "./file-checkpointer.js";
import { coderAgent, repoTools, type EffectLog } from "./fixtures.js";
import { buildLoopGraph } from "./loop-graph.js";
import { recoverInput, resumeInput, startInput, streamLoop } from "./run.js";
import { answer, callTools, type ScriptedMove } from "./scripted-model.js";
import { defineTool } from "./tool.js";
import type { LoopAgent } from "./types.js";

const Args = z.tuple([
  z.string(),
  z.enum(["start", "resume", "recover"]),
  z.enum(["approval", "parallel"]),
]);
const [dir, mode, scenario] = Args.parse(process.argv.slice(2));
const THREAD = "run-1";

const log: EffectLog = (effect) => {
  appendFileSync(join(dir, "effects.log"), `${effect}\n`);
};

/** Hangs as long as SLOW_MS says: long in the process that gets killed, short after. */
const slowTool = defineTool({
  name: "slow-step",
  input: z.object({}),
  run: async () => {
    log("slow started");
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.SLOW_MS ?? "1")));
    log("slow finished");
    return "slow-done";
  },
});

const scripts: Record<typeof scenario, readonly ScriptedMove[]> = {
  approval: [
    callTools({ id: "r1", name: "read-file", args: { path: "a.ts" } }),
    callTools({ id: "w1", name: "write-file", args: { path: "a.ts", content: "new" } }),
    answer("written"),
  ],
  parallel: [
    callTools(
      { id: "fast", name: "read-file", args: { path: "fast.ts" } },
      { id: "slow", name: "slow-step", args: {} },
    ),
    answer("both done"),
  ],
};

const base = coderAgent({
  moves: scripts[scenario],
  log,
  onModelCall: (index) => {
    appendFileSync(join(dir, "model-calls.log"), `${String(index)}\n`);
  },
});
const agent: LoopAgent = { ...base, tools: [...repoTools(log), slowTool] };
const graph = buildLoopGraph(agent, new FileCheckpointSaver(join(dir, "checkpoints.json")));

const input =
  mode === "start"
    ? startInput("change a.ts")
    : mode === "resume"
      ? await resumeInput(graph, THREAD, { approved: true, by: "lead" })
      : recoverInput();

for await (const event of streamLoop(graph, input, { thread: THREAD })) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
// A paused run waits for a person: the process stays up until it is killed.
if (mode === "start") setInterval(() => undefined, 60_000);
