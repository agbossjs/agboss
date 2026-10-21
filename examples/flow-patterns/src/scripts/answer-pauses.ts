import { AGBossError, createApp, type ExecutionOutput } from "agboss";
import { parseArgs } from "node:util";
import { FlowPatternsApplication } from "../flow-patterns.application.js";

// npm run answer -- <pauseId> [<pauseId> …] [--decline]
// Answers pauses another process left waiting — they are records in the SQLite stores — all at
// once, from a second terminal: two answers at nearly the same time, or a second press of an
// answer already given (NotPausedError). The pause ids are the ones the terminal channel printed.
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { decline: { type: "boolean", default: false } },
});
if (positionals.length === 0) {
  process.stderr.write("usage: npm run answer -- <pauseId> [<pauseId> …] [--decline]\n");
  process.exit(2);
}
const decision = values.decline
  ? { approved: false, reason: "declined from the second terminal" }
  : { approved: true };

/** One line about a resume: where the run is now, or why the answer was refused. */
function lineOf(pauseId: string, outcome: PromiseSettledResult<ExecutionOutput>): string {
  if (outcome.status === "rejected") {
    const error: unknown = outcome.reason;
    if (error instanceof AGBossError) return `${pauseId}: ${error.name} — ${error.message}`;
    throw error;
  }
  const { finish, output, pending } = outcome.value;
  return finish === undefined
    ? `${pauseId}: taken — the run waits for ${String(pending.length)} more`
    : `${pauseId}: taken — finished at ${finish.name}: ${JSON.stringify(output)}`;
}

const app = await createApp(FlowPatternsApplication);
try {
  const outcomes = await Promise.allSettled(
    positionals.map((pauseId) => app.resume({ pauseId, decision })),
  );
  outcomes.forEach((outcome, index) => {
    process.stdout.write(`${lineOf(positionals[index] ?? "?", outcome)}\n`);
  });
} finally {
  await app.close();
}
