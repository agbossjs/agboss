import { renameSync } from "node:fs";
import { REAL_REPLACE_OPS, type ReplaceOps } from "../../../src/skills/replace.js";
import { skillsLines, syncSkills } from "../../../src/skills/sync.js";

/**
 * One skills sync in a process of its own (#983 D1, D3, #1013): `kill` SIGKILLs the process at the
 * second rename of the swap (the new folder going into place); `pause` blocks there for `pauseMs`
 * and goes on; `sync` waits for the common start time, then prints its warning lines as JSON.
 * argv: root, mode, start time (ms since the epoch), pause (ms).
 */
const [root = "", mode = "sync", startAt = "0", pauseMs = "0"] = process.argv.slice(2);

const isSwapIn = (from: string, to: string): boolean =>
  from.includes(".agboss-skills-") && !from.endsWith("-old") && to.endsWith("skills/agboss");

const pausing: ReplaceOps = {
  ...REAL_REPLACE_OPS,
  rename: (from, to) => {
    if (isSwapIn(from, to))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(pauseMs));
    renameSync(from, to);
  },
};

const killing: ReplaceOps = {
  ...REAL_REPLACE_OPS,
  rename: (from, to) => {
    if (isSwapIn(from, to)) process.kill(process.pid, "SIGKILL");
    renameSync(from, to);
  },
};

while (Date.now() < Number(startAt)) {
  // a barrier: every racer starts the sync in the same millisecond
}
const done = syncSkills({ root, isEnabled: true }, "check", {
  home: () => undefined,
  ...(mode === "kill" ? { replace: killing } : {}),
  ...(mode === "pause" ? { replace: pausing } : {}),
});
process.stdout.write(JSON.stringify({ lines: skillsLines(done), status: done.result.status }));
