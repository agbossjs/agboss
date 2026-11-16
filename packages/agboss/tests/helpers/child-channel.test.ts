/**
 * #1128: a child test process answers on the IPC channel, so the logs it writes to stdout and
 * stderr — a framework's warning line, a half line, a JSON-looking line — never mix with its result.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runNodeReporting, startNode } from "./process.js";

const SCRIPT = fileURLToPath(new URL("./child-channel.fixture.ts", import.meta.url));

// the child is `node --import tsx`: a cold compile under a loaded machine took over the 5 s default (#1225)
describe(
  "#1128: the result of a child process goes over IPC, never stdout",
  { timeout: 60_000 },
  () => {
    it("C1 a child that logs to stdout and stderr before and after reports its result intact", async () => {
      const run = await runNodeReporting(["--import", "tsx", SCRIPT, "noisy"]);

      expect(run.status).toBe(0);
      expect(run.messages).toEqual([{ answer: 42 }]);
      expect(run.stdout).toContain('{"level":"warn"');
      expect(run.stderr).toContain("deprecated");
    });

    it("C2 a barrier: the child waits for the parent's message, then reports", async () => {
      const child = startNode(["--import", "tsx", SCRIPT, "barrier"]);

      await child.waitFor((message) => message === "ready");
      child.send("go");
      const run = await child.exited;

      expect(run.status).toBe(0);
      expect(child.messages()).toEqual(["ready", "went"]);
    });

    it("C3 a child that ends without the awaited message rejects the wait, with its stderr", async () => {
      const child = startNode(["--import", "tsx", SCRIPT, "silent"]);

      await expect(child.waitFor((message) => message === "ready")).rejects.toThrow(
        /ended without/,
      );
    });

    it("#1225 C3 a child that leaves a TCP socket open reports it as lingering; one that only runs on does not", async () => {
      const leaks = await runNodeReporting(["--import", "tsx", SCRIPT, "leaks"]);
      const slow = await runNodeReporting(["--import", "tsx", SCRIPT, "slow"]);

      expect(leaks.messages).toEqual([{ answer: 1 }, { lingering: true }]);
      expect(slow.messages).toEqual([{ answer: 1 }]);
      expect(slow.status).toBe(0);
    });
  },
);
