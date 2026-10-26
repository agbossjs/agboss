import { CassetteMissingError, testWith, VCRMode } from "@agboss/core/testing";
import { expect } from "vitest";
import { JobScoutApplication } from "../src/job-scout.application.js";
import { MainRouter } from "../src/routers/main.router.js";
import { ProfilerAgent } from "../src/agents/profiler.agent.js";
import { ChatWorkflowStart } from "../src/workflow-starts/chat.workflow-start.js";
import { ChatWorkflowFinish } from "../src/workflow-finishes/chat.workflow-finish.js";

/**
 * Replays tests/cassettes/job-scout-brief.cassette.json: every model call of the run (the guardrails,
 * the Jev main router, the profiler) answers from the cassette — no script, no key, no network.
 * Re-record after a prompt, tool or flow change: `mode: VCRMode.RECORD` with a model key.
 */
const test = testWith(JobScoutApplication, {
  vcr: { cassetteName: "job-scout-brief", dir: "tests/cassettes", mode: VCRMode.REPLAY },
});

test("the recorded brief run replays through the real graph without a model", async ({ app }) => {
  const result = await app.execute(ChatWorkflowStart, { text: "propose a search brief" });

  expect(result).toFollowPath([ChatWorkflowStart, MainRouter, ProfilerAgent, ChatWorkflowFinish]);
  expect(result).toFinishWith(ChatWorkflowFinish, {
    text: "Brief: senior backend, Israel, 20 jobs, all boards",
  });
});

test("a message the cassette did not record fails loudly instead of calling a model", async ({
  app,
}) => {
  await expect(
    app.execute(ChatWorkflowStart, { text: "find me jobs in Haifa" }),
  ).rejects.toBeInstanceOf(CassetteMissingError);
});
