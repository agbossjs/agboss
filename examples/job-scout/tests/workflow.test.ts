import { describe, expect, it } from "vitest";
import { workflowOf } from "agboss/testing";
import { describeWorkflow, withProfile } from "agboss";
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
      read_resume: "ResumeReader",
      greenhouse_jobs:
        "JobFitJudge (ROUTER_FACTORY), JOB_SEARCH, GreenhouseBoards (JOB_SEARCH, ApplicationContext), ExecutionContext",
      read_shortlist: "ShortlistServer, SHORTLIST",
      save_shortlist: "ShortlistServer, SHORTLIST",
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
  it("AC4: every kind of component — tools, agents, injectable, MCP server and tools, knowledge base", async () => {
    const lines = describeWorkflow(await workflowOf(JobScout));
    const has = (text: string): boolean => lines.some((line) => line.includes(text));

    expect(lines[0]).toMatch(/^job-scout-workflow 3\.0\.0 · config [0-9a-f]{8}$/);
    expect(has("· read_resume (local)")).toBe(true);
    expect(
      has(
        "· greenhouse_jobs (local) ← JobFitJudge (ROUTER_FACTORY), JOB_SEARCH, GreenhouseBoards (JOB_SEARCH, ApplicationContext)",
      ),
    ).toBe(true);
    expect(
      ["  profiler-agent  ", "  scout-agent  ", "  shortlist-agent  "].every((agent) =>
        lines.some((l) => l.startsWith(agent)),
      ),
    ).toBe(true);
    expect(has("· read_shortlist (MCP shortlist) ← ShortlistServer, SHORTLIST")).toBe(true);
    expect(
      has(
        "· save_shortlist (channel:terminal-user-channel, MCP shortlist, uses channel) ← ShortlistServer, SHORTLIST",
      ),
    ).toBe(true);
    expect(has("rag: company_notes (tool, k 3)")).toBe(true);
    // #261: the application's defaults under the workflow's own (its window), each with its source
    expect(
      has(
        "defaults: temperature 0 (job-scout-application) · maxTokens 4000 (own) · uncompactedTurns 8 (job-scout-workflow)",
      ),
    ).toBe(true);
    expect(has("· search_company_notes (local)")).toBe(true);
  });
});
