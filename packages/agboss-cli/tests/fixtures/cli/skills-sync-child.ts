import { renameSync } from "node:fs";
import { REAL_REPLACE_OPS, type ReplaceOps } from "../../../src/skills/replace.js";
import { skillsLines, syncSkills } from "../../../src/skills/sync.js";

/**
 * One skills sync in a process of its own (#983 D1, D3): `kill` SIGKILLs the process at the second
 * rename of the swap (the new folder going into place); `sync` waits for the common start time, then
 * prints its warning lines as JSON. argv: root, mode, start time (ms since the epoch).
 */
const [root = "", mode = "sync", startAt = "0"] = process.argv.slice(2);

const killing: ReplaceOps = {
  ...REAL_REPLACE_OPS,
  rename: (from, to) => {
    if (from.includes(".agboss-skills-") && !from.endsWith("-old") && to.endsWith("skills/agboss"))
      process.kill(process.pid, "SIGKILL");
    renameSync(from, to);
  },
};

while (Date.now() < Number(startAt)) {
  // a barrier: every racer starts the sync in the same millisecond
}
const done = syncSkills({ root, isEnabled: true }, "check", {
  home: () => undefined,
  ...(mode === "kill" ? { replace: killing } : {}),
});
process.stdout.write(JSON.stringify({ lines: skillsLines(done), status: done.result.status }));
