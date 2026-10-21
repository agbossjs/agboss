import { describe, expect, it } from "vitest";
import { workflowOf } from "agboss/testing";
import { withProfile } from "agboss";
import { JobScout } from "../src/job-scout.workflow.js";

describe("job-scout workflow", () => {
  it("assembles from its components; constructor dependencies resolved", async () => {
    const workflow = await workflowOf(JobScout);

    expect(workflow.config).toMatchObject({ name: "job-scout-workflow", version: "3.0.0" });
    expect(Object.keys(workflow.config.agents)).toEqual([
      "profiler-agent",
      "scout-agent",
      "shortlist-agent",
    ]);
    expect(workflow.toolDependencies).toEqual({
      "read-resume-tool": "ResumeReader",
      "greenhouse-jobs-tool":
        "JobFitJudge (ROUTER_FACTORY), JOB_SEARCH, GreenhouseBoards (JOB_SEARCH, ApplicationContext), ExecutionContext",
      "read-shortlist-tool": "ShortlistServer, SHORTLIST",
      "save-shortlist-tool": "ShortlistServer, SHORTLIST",
    });
    expect(workflow.config.compactions?.["conversation-compaction"]).toMatchObject({
      turnsBetweenCompactions: 5,
      summaryQueueLength: 10,
      model: { maxTokens: 400 },
    });
  });

  it("the scout-low-thinking profile changes only the scout's thinking", async () => {
    const base = await workflowOf(JobScout);
    const profiled = await withProfile(
      base,
      "scout-low-thinking",
      new URL("..", import.meta.url).pathname,
    );

    expect(profiled.config.version).toBe("3.0.0-low-thinking");
    expect(profiled.config.agents["scout-agent"]?.thinking).toBe("low");
    expect(profiled.config.agents["profiler-agent"]).toEqual(base.config.agents["profiler-agent"]);
  });
});
