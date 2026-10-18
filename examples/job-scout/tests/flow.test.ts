import { describe, expect, it } from "vitest";
import { workflowOf } from "agboss/testing";
import { describeWorkflow } from "agboss";
import { replyWith, callTool, routeTo, testWith } from "agboss/testing";
import { JobScout } from "../src/job-scout.workflow.js";
import { JobScoutApplication } from "../src/job-scout.application.js";
import { MainRouter } from "../src/routers/main.router.js";
import { ProfilerAgent } from "../src/agents/profiler.agent.js";
import { ShortlistAgent } from "../src/agents/shortlist.agent.js";
import { SaveShortlist } from "../src/mcp/save-shortlist.mcp.js";
import { ShortlistServer } from "../src/mcp/shortlist.server.js";
import { ChatWorkflowStart } from "../src/workflow-starts/chat.workflow-start.js";
import { ChatWorkflowFinish } from "../src/workflow-finishes/chat.workflow-finish.js";

const workflow = await workflowOf(JobScout);

describe("job-scout on the path grammar (#272)", () => {
  it("one path a turn: start → main router → the agent that answers → the finish", () => {
    const lines = describeWorkflow(workflow);

    expect(lines).toEqual(
      expect.arrayContaining([
        "flow",
        "  start(ChatWorkflowStart)",
        "    .returns(WorkflowStartTextDto)",
        "    .toRouter(MainRouter)",
        "    .chooseOne(",
        "      route(ProfilerAgent)",
        "        .toFinish(ChatWorkflowFinish),",
        "      route(ScoutAgent)",
        "        .toFinish(ChatWorkflowFinish),",
        "      route(ShortlistAgent)",
        "        .toFinish(ChatWorkflowFinish)",
        "    )",
      ]),
    );
    expect(Object.keys(workflow.config.agents)).toEqual([
      "profiler-agent",
      "scout-agent",
      "shortlist-agent",
    ]);
  });

  it("the main router is Jev, one visit a run, its routes sorted by name", () => {
    const [main] = workflow.routers;

    expect(workflow.routers).toHaveLength(1);
    expect(main).toMatchObject({ name: "main-router", model: "typesafe/jev-1.13", maxVisits: 1 });
    expect(main?.routes.map((item) => item.option)).toEqual([
      "profiler-agent",
      "scout-agent",
      "shortlist-agent",
    ]);
    expect(describeWorkflow(workflow)).toContain(
      "  main-router  decisions typesafe/jev-1.13 · maxVisits 1 — Sends the job seeker's message to the agent that answers it",
    );
  });

  it("limits come from settings() — $0.10 a run, $1 a day; 2 steps a run, at most 12", () => {
    expect(workflow.limits).toEqual({ perRun: { cost: 0.1 }, perDay: { cost: 1 } });
    expect(describeWorkflow(workflow)).toContain(
      "limits    steps 2–2 (maxSteps 12) · run $0.1 · day $1",
    );
  });

  it("guards, the approval pause and compaction stay on", () => {
    expect(workflow.config.guards?.input).toHaveProperty("prompt_injection");
    expect(workflow.config.guards?.output).toHaveProperty("pii");
    expect(workflow.config.compaction).toMatchObject({ every: 5, keep: 10 });
  });
});

const test = testWith(JobScoutApplication);
const job = {
  title: "Backend Engineer",
  company: "Fireblocks",
  location: "Tel Aviv",
  link: "https://example.com/1",
  fit: 81,
};

describe("job-scout by script (#135): a turn, the approval pause and resume", () => {
  test("AC12: the main router sends the message to the agent, whose answer finishes the turn", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(MainRouter).thenReturn(routeTo(ProfilerAgent));
    mockLlm(ProfilerAgent).thenReturn(replyWith("Brief: senior backend, Israel"));

    const result = await app.execute(ChatWorkflowStart, { text: "propose a search brief" });

    expect(result).toFollowPath([ChatWorkflowStart, MainRouter, ProfilerAgent, ChatWorkflowFinish]);
    expect(result).toFinishWith(ChatWorkflowFinish, { text: "Brief: senior backend, Israel" });
    expect(mockLlm(MainRouter)).toHaveBeenAskedWith({ input: "propose a search brief" });
  });

  test("AC12: saving to the shortlist waits for approval; after it the agent's answer finishes the turn", async ({
    app,
    mockLlm,
    mcpOf,
  }) => {
    mockLlm(MainRouter).thenReturn(routeTo(ShortlistAgent));
    mockLlm(ShortlistAgent).thenReturn(
      callTool(SaveShortlist, { jobs: [job] }),
      replyWith("Saved 1 job."),
    );
    const written: string[] = [];
    mcpOf(ShortlistServer).thenReturn({
      read_text_file: () => Promise.reject(new Error("ENOENT: no such file")),
      write_file: ({ content }: { content: string }) => {
        written.push(content);
        return Promise.resolve({ content: "ok" });
      },
    });

    const paused = await app.execute(ChatWorkflowStart, { text: "save the first job" });
    const done = await app.resume(paused.thread, { approved: true, by: "dana" });

    expect(paused).toHavePausedAt(ShortlistAgent);
    expect(done).toFinishWith(ChatWorkflowFinish, { text: "Saved 1 job." });
    expect(mockLlm(MainRouter).requests).toHaveLength(1);
    expect(mockLlm(ShortlistAgent)).toHaveCalledTools([SaveShortlist]);
    expect(written).toEqual([
      "# Shortlist\n- [Backend Engineer — Fireblocks, Tel Aviv](https://example.com/1) · fit 81%\n",
    ]);
  });

  test("AC12: a declined save is not written; the agent answers after the decision", async ({
    app,
    mockLlm,
    mcpOf,
  }) => {
    mockLlm(MainRouter).thenReturn(routeTo(ShortlistAgent));
    mockLlm(ShortlistAgent).thenReturn(
      callTool(SaveShortlist, { jobs: [job] }),
      replyWith("Not saved."),
    );
    const shortlist = mcpOf(ShortlistServer);

    const paused = await app.execute(ChatWorkflowStart, { text: "save the first job" });
    const done = await app.resume(paused.thread, { approved: false, by: "dana", reason: "no" });

    expect(done).toFinishWith(ChatWorkflowFinish, { text: "Not saved." });
    expect(shortlist.calls).toEqual([]);
  });
});
